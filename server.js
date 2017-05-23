// --------------------------------------------------------------------------------------------------------------------

// core
const http = require('http')
const path = require('path')

// npm
const express = require('express')
const morgan = require('morgan')
const request = require('request')
const validUrl = require('valid-url')
const FeedParser = require('feedparser')

// local
const booleanify = require('./lib/booleanify.js')

// --------------------------------------------------------------------------------------------------------------------
// helpers

const files = path.join(__dirname, 'static')

function sendError(res, status, err) {
  res.status(status).json({
    "err" : '' + err,
  })
}

// From : https://github.com/danmactough/node-feedparser/blob/master/examples/iconv.js (with changes)
function getHeaderParams(header) {
  return ( header || '' ).split(';').reduce((acc, val) => {
    var kv = val.split('=')
    acc[kv[0].trim()] = ( kv[1] || '' ).trim()
    return acc
  }, {})
}

// --------------------------------------------------------------------------------------------------------------------
// application

var app = express()

app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'dev'))
app.use(express.static('static'))

app.get('/convert', (req, res) => {
  let queryUrl = req.query.url
  let minify = booleanify(req.query.minify)

  console.log('queryUrl=' + queryUrl)
  console.log('minify=' + minify)

  let responseSent = false

  if ( !queryUrl ) {
    responseSent = true
    return sendError(res, 400, "provide a 'url' parameter in your query")
  }

  // check if this looks like a valid URL
  let url = validUrl.isWebUri(queryUrl)
  if ( !url ) {
    responseSent = true
    return sendError(res, 400, "invalid 'url' : " + queryUrl)
  }

  console.log('validUrl=' + url)

  // create the feedparser ready for when we get the request back
  var feedparser = new FeedParser({
    normalize       : true,
    addmeta         : false,
    feedurl         : url,
    resume_saxerror : true,
  })

  // start the request
  const fetch = request(url, { timeout : 10000, pool : false })
  fetch.setHeader('user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246')
  fetch.setHeader('accept', 'text/html,application/xhtml+xml')

  // check for request errors
  fetch.on('error', function (err) {
    responseSent = true
    return sendError(res, 500, "error when requesting the feed : " + err)
  })

  // Process the response when we get something back.
  fetch.on('response', function(feed) {
    console.log('request.response')
    if ( feed.statusCode != 200 ) {
      return this.emit('error', new Error('Bad status code'))
    }

    // See if this is a weird charset:
    //
    // * https://github.com/danmactough/node-feedparser/blob/master/examples/iconv.js
    //
    let headerParams = getHeaderParams(feed.headers['content-type'])
    console.log('headerParams:', headerParams)
    // feed = maybeTranslate(feed, headerParams.charset)

    // finally, pipe into the feedparser
    feed.pipe(feedparser)
  })

  // save data as we stumble upon it
  let data = {}

  // now listen to events from the feedparser
  feedparser.on('error', function(err) {
    console.log('feedparser error :', err)
    responseSent = true
    return sendError(res, 500, "error parsing feed : " + err)
  })

  feedparser.on('meta', function(meta) {
    console.log('meta.link:', meta.link)
    // console.log(meta)

    // Going through fields in the same order as : https://jsonfeed.org/version/1

    // version (required, string)
    data.version = "https://jsonfeed.org/version/1"

    // title (required, string)
    data.title = meta.title

    // home_page_url (optional)
    if ( meta.link ) {
      data.home_page_url = meta.link
    }

    // feed_url (optional, string) - is self-referencing, but we don't have anything here to reference since we're generating from either
    // an RSS or Atom feed.

    // description (optional, string)
    if ( meta.description ) {
      data.description = meta.description
    }

    // user_comment (optional, string) - nothing in RSS or Atom can be used here

    // next_url (optional, string) - nothing in RSS or Atom can be used here

    // icon (optional, string) - nothing in RSS or Atom can be used here

    // favicon (optional, string) - Atom might have this
    if ( meta.favicon ) {
      data.favicon = meta.favicon
    }

    // author{name,url,avatar} (optional, must include one if exists)
    if ( meta.author ) {
      // even in Atom feeds with Author Name, Email and URI, feedparser only gives `meta.author`
      data.author = {
        name : meta.author,
      }
    }

    // expired (optional, boolean) - nothing in RSS or Atom can be used here

    // hubs (optional, array of objects) - ignoring for now

    // items (array, required) - add this now for appending to later
    data.items = []
  })

  feedparser.on('data', function(post) {
    // console.log('feedparser.data')
    console.log(' - post = ' + post.guid)

    let item = {}

    // Going through fields in the same order as : https://jsonfeed.org/version/1

    // id (required, string) - use `guid`
    if ( post.guid ) {
      item.guid = post.guid
    }
    else {
      // What should we do if there is no `guid` since `id` is required?
    }

    // url (optional, string) - the permalink if you like, may be the same as `id`
    if ( post.link ) {
      item.url = post.link
    }
    else {
      // What should we do if there is no `link` since we really should have a `url` here?
    }

    // external_url (optional, string) - ignore since we're adding a `url` anyway

    // title (optional, string)
    if ( post.title ) {
      item.title = post.title
    }

    // content_html/content_text (optional, string) - one must be present
    if ( post.description ) {
      item.content_html = post.description
    }

    // summary (optional, string)
    if ( post.summary ) {
      item.summary = post.summary
    }

    // image (optional, string)
    if ( post.image ) {
      if ( post.image.constructor === Object ) {
        // skip for now
      }
      else {
        item.image = post.image
      }
    }

    // banner_image (optional, string) - ???

    // date_published (optional, string)
    if ( post.pubDate ) {
      item.date_published = post.pubDate
    }

    // date_modified (optional, string) - ???

    // author (optional, object)
    if ( post.author ) {
      item.author = {
        name : post.author,
      }
    }

    // tags (optional, string[])

    // finally, push this `item` onto `data.items`
    data.items.push(item)
  })

  // and finish the request
  feedparser.on('end', function() {
    console.log('feedparser.end')

    // don't do anything if we have already errored out and sent a response
    if ( responseSent ) {
      return
    }

    // alright to send the data
    if ( minify ) {
      res.json(data)
    }
    else {
      res.set({'Content-Type': 'application/json; charset=utf-8'})
      res.status(200)
      res.send(JSON.stringify(data, undefined, '  '))
    }
  })
})

// --------------------------------------------------------------------------------------------------------------------
// server

const port = process.env.PORT || 3000
const server = http.createServer(app)
server.listen(port, () => {
  console.log('Listening on port %s', port)
})

// --------------------------------------------------------------------------------------------------------------------
