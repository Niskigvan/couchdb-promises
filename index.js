
// http://docs.couchdb.org/en/stable/api/index.html
'use strict'
const assert = require('assert')
const http = require('http')
const https = require('https')
const querystring = require('querystring')
const urlParse = require('url').parse

// https://wiki.apache.org/couchdb/HTTP_view_API#Querying_Options
const QUERY_KEYS_JSON = ['key', 'keys', 'startkey', 'endkey']

module.exports = function (opt) {
  const config = {
    requestTimeout: 10000, // ms
    verifyCertificate: true,
    baseUrl:"http://127.0.0.1:5984", //string @required
    defaultDDocName:"index"
  }
  Object.assign(config, opt)

  function isValidUrl (url) {
    const o = urlParse(url)
    if (
      ['http:', 'https:'].indexOf(o.protocol) >= 0 &&
      o.slashes === true &&
      !Number.isNaN(parseInt(o.port, 10)) &&
      o.hostname
    ) return true
    return false
  }

  function createQueryString (queryObj) {
    const obj = Object.assign({}, queryObj)
    QUERY_KEYS_JSON.forEach(key => {
      if (key in obj) {
        obj[key] = JSON.stringify(obj[key])
      }
    })
    return Object.keys(obj).length ? `?${querystring.stringify(obj)}` : ''
  }

  function statusCode (statusCodes, status) {
    const codes = Object.assign({}, http.STATUS_CODES, statusCodes)
    return codes[status] || 'unknown status'
  }

  function request (param) {
    const t0 = Date.now()

    const method = param.method
    const url = param.url || config.baseUrl
    const statusCodes = param.statusCodes
    const postData = param.postData
    const respStream = param.stream
    const postContentType = (param.postContentType===undefined
        && "application/json"
        || (param.postContentType===false || param.postContentType===null) && "application/octet-stream"
        || param.postContentType)
    const acceptContentType = (param.acceptContentType===undefined
        && "application/json"
        || (param.acceptContentType===false || param.acceptContentType===null) && "*/*"
        || param.acceptContentType)


    const o = urlParse(url)
    const httpOptions = {
      hostname: o.host && o.host.split(':')[0],
      port: o.port,
      path: o.path,
      auth: o.auth,
      protocol: o.protocol,
      method: method,
      rejectUnauthorized: config.verifyCertificate,
      headers: {
        'user-agent': 'couchdb-promises',
        accept: acceptContentType
      }
    }

    // If passed, propagate Destination header required for HTTP COPY
    if (param.headers && param.headers.Destination) {
      httpOptions.headers.Destination = param.headers.Destination
    }
    if(param.url)
	    if (!isValidUrl(url))
	      return Promise.reject({
	        headers: {},
	        data: new Error('Bad request - Invalid url'),
	        status: 400,
	        message: 'Bad request - Invalid url',
	        duration: Date.now() - t0
	      })

    let body
    let stream
    let error

    if (Buffer.isBuffer(postData)) {
      //
      // buffer
      //
      body = postData
      httpOptions.headers['content-type'] = postContentType
      httpOptions.headers['content-length'] = Buffer.byteLength(postData)
    } else if (postData && postData.readable && typeof postData._read === 'function') {
      //
      // stream
      //
      httpOptions.headers['content-type'] = postContentType
      httpOptions.headers['Transfer-Encoding'] = 'chunked'
      stream = postData
    } else if (Object.prototype.toString.call(postData) === '[object Object]') {
      //
      // regular object -> JSON
      //
      try {
        body = JSON.stringify(postData)
      } catch (err) {
        error = err
      }
      httpOptions.headers['content-type'] = 'application/json'
      httpOptions.headers['content-length'] = Buffer.byteLength(body)
    } else if (typeof postData === 'string') {
      //
      // string
      //
      body = postData
      httpOptions.headers['content-type'] = postContentType
      httpOptions.headers['content-length'] = body.length
    } else if (postData) {
      error = 'unsoported post data'
    }

    if (error) {
      return Promise.reject({
        headers: {},
        data: error,
        status: 400,
        message: 'invalid post data',
        duration: Date.now() - t0
      })
    }
    return new Promise(function (resolve, reject) {
      const lib = httpOptions.protocol === 'https:' ? https : http
      const req = respStream && lib.request(httpOptions, function (res) {
      	if(Array.isArray(respStream))
      		respStream.reduce(function(acc,v){return acc.pipe(v); },res)
        else res.pipe(respStream)
        const ret = {
          headers: res.headers,
          status: res.statusCode,
          message: statusCode(statusCodes, res.statusCode),
          duration: Date.now() - t0
        }

        if (ret.status < 400) {
          return resolve(ret)
        } else {
          return reject(ret)
        }
      }) || lib.request(httpOptions, function (res) {
        // console.error(url)
        // console.error(res.req._headers)
        let buffer = ''
        res.setEncoding('utf8')
        res.on('data', function (data) {
          buffer += data
        })
        res.on('end', function () {
          let ret
          try {
            ret = {
              headers: res.headers,
              data: acceptContentType=="application/json" && JSON.parse(buffer || '{}') || buffer,
              status: res.statusCode,
              message: statusCode(statusCodes, res.statusCode),
              duration: Date.now() - t0
            }
          } catch (err) {
            ret = {
              headers: res.headers,
              data: err,
              status: 500,
              message: err.message || 'internal error',
              duration: Date.now() - t0
            }
          }

          if (ret.status < 400) {
            return resolve(ret)
          } else {
            return reject(ret)
          }
        })
      })

      req.setTimeout(config.requestTimeout, function () {
        req.abort()
        reject({
          headers: {},
          data: new Error('request timed out'),
          status: 500,
          message: 'Error: request timed out',
          duration: Date.now() - t0
        })
      })

      req.on('error', function (err) {
        reject({
          headers: {},
          data: err,
          status: 500,
          message: err.message || 'internal error',
          duration: Date.now() - t0
        })
      })

      if (body) {
        req.write(body)
        req.end()
      } else if (stream) {
        stream.on('data', function (chunk) {
          req.write(chunk)
        })
        stream.on('end', function () {
          req.end()
        })
      } else {
        req.end()
      }
    })
  }

  const couch = {}

  /**
   * All promisses are settled  with an object with the folloing properties
   *  headers: {Object} - response headers
   *  data:  {Object} - response body from the database server
   *  status: {Number} - http status code
   *  message: {String} - http message
   */

  /**
   * Request 
   * @param  {{
   			method:String,
   			url:String,
   			statusCodes:{[key:Number]:String},
   			postData:any,
   			postContentType:String,
   			acceptContentType:String,
   			respStream:StreamWritable|Array<StreamWritable>
   			}} params
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.request=request
  /**
   * Get server info
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.getInfo = function getInfo (stream_or_ct) {
    return request({
      url: `${config.baseUrl}/`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully'
      }
    })
  }

  /**
   * Get the list of all databases.
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.listDatabases = function listDatabases (stream_or_ct) {
    return request({
      url: `${config.baseUrl}/_all_dbs`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully'
      }
    })
  }

  /**
   * Create database
   * @param  {String} dbName
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.createDatabase = function createDatabase (dbName,stream_or_ct) {
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'PUT',
      statusCodes: {
        201: 'Created - Database created successfully',
        400: 'Bad Request - Invalid database name',
        401: 'Unauthorized - CouchDB Server Administrator privileges required',
        412: 'Precondition Failed - Database already exists'
      }
    })
  }

  /**
   * Get database
   * @param  {String} dbName
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.getDatabase = function getDatabase (dbName,stream_or_ct) {
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully',
        404: 'Not Found – Requested database not found'
      }
    })
  }

  /**
   * Get database head
   * @param  {String} dbName
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.getDatabaseHead = function getDatabaseHead (dbName,stream_or_ct) {
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'HEAD',
      statusCodes: {
        200: 'OK - Database exists',
        404: 'Not Found – Requested database not found'
      }
    })
  }

  /**
   * Delete database
   * @param  {String} dbName
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.deleteDatabase = function deleteDatabase (dbName,stream_or_ct) {
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'DELETE',
      statusCodes: {
        200: 'OK - Database removed successfully',
        400: 'Bad Request - Invalid database name or forgotten document id by accident',
        401: 'Unauthorized - CouchDB Server Administrator privileges required',
        404: 'Not Found - Database doesn’t exist'
      }
    })
  }

  /**
   * Get all documents
   * @param  {String} dbName
   * @param  {Object} [query]
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.getAllDocuments = function getAllDocuments (dbName, queryObj,stream_or_ct) {
    let keys
    queryObj.keys && (keys = queryObj.keys) && (delete queryObj.keys)
    const queryStr = createQueryString(queryObj)
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/_all_docs${queryStr}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: keys && 'POST' || 'GET',
      [keys && "postData" || null]:keys,
      [keys && "postContentType" || null]:'application/json',
      statusCodes: {
        200: 'OK - Request completed successfully'
      }
    })
  }

  /**
   * Get Document Head
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {Object} [query]
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.getDocumentHead = function getDocumentHead (dbName, docId, queryObj,stream_or_ct) {
    const queryStr = createQueryString(queryObj)
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}${queryStr}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'HEAD',
      statusCodes: {
        200: 'OK - Document exists',
        304: 'Not Modified - Document wasn’t modified since specified revision',
        401: 'Unauthorized - Read privilege required',
        404: 'Not Found - Document not found'
      }
    })
  }

  /**
   * Get Document or call show function
   * @param  {String} dbName
   * @param  {String} docId can be equal to "docId" or "show_func_name/docId" or "ddoc_name/show_func_name/docId" or "show_func_name/"
   * @param  {Object} [query]
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.getDocument = function getDocument (dbName, docId, queryObj,stream_or_ct) {
    const queryStr = createQueryString(queryObj)
    let docPathArr = docId.split("/")
    docId=docPathArr.pop()
    let docPath=(docPathArr.length==1
        && `_design/${config.defaultDDocName}/_show/${docPathArr[0]}/`
        || docPathArr.length==2 && `_design/${docPathArr[0]}/_show/${docPathArr[1]}/`
        || "")
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/${docPath}${docId && encodeURIComponent(docId) || ""}${queryStr}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully',
        304: 'Not Modified - Document wasn’t modified since specified revision',
        400: 'Bad Request - The format of the request or revision was invalid',
        401: 'Unauthorized - Read privilege required',
        404: 'Not Found - Document not found'
      }
    })
  }

  /**
   * Copy an existing document to a new document
   * @param  {String} dbName
   * @param  {String} docId  can be equal to "docId" or "update_func_name/docId" or "ddoc_name/update_func_name/docId" or "update_func_name/"
   * @param  {String} newDocId
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.copyDocument = function copyDocument (dbName, docId, newDocId,stream_or_ct) {
    if (docId && newDocId) {
      return request({
        headers: { Destination: newDocId },
        url: `${config.baseUrl}/${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}`,
        [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
        method: 'COPY',
        statusCodes: {
          201: 'Created – Document created and stored on disk',
          202: 'Accepted – Document data accepted, but not yet stored on disk',
          400: 'Bad Request – Invalid request body or parameters',
          401: 'Unauthorized – Write privileges required',
          404: 'Not Found – Specified database or document ID doesn’t exists',
          409: 'Conflict – Document with the specified ID already exists or specified revision is not latest for target document'
        }
      })
    }
  }

  /**
   * Create a new document (if docId seted) or new revision of an existing document or call _update func
   * @param  {String} dbName
   * @param  {Object} doc
   * @param  {String|null} [docId]
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.updateDocument = function createDocument (dbName, doc, docId,stream_or_ct) {
    let docPathArr = docId && docId.split("/") || []
    docId=docId && docPathArr.pop() || null
    let docPath=(docPathArr.length==1
        && `_design/${config.defaultDDocName}/_update/${docPathArr[0]}/`
        || docPathArr.length==2 && `_design/${docPathArr[0]}/_update/${docPathArr[1]}/`
        || "")
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/${docPath}${docId && encodeURIComponent(docId)}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: docId && !docPath.length && 'PUT' || 'POST',
      postData: doc,
      postContentType: 'application/json',
      statusCodes: {
        201: 'Created – Document created and stored on disk',
        202: 'Accepted – Document data accepted, but not yet stored on disk',
        400: 'Bad Request – Invalid request body or parameters',
        401: 'Unauthorized – Write privileges required',
        404: 'Not Found – Specified database or document ID doesn’t exists',
        409: 'Conflict – Document with the specified ID already exists or specified revision is not latest for target document'
      }
    })
  }

  /**
   * Delete a named document
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} rev
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.deleteDocument = function deleteDocument (dbName, docId, rev,stream_or_ct) {
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}?rev=${rev}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'DELETE',
      statusCodes: {
        200: 'OK - Document successfully removed',
        202: 'Accepted - Request was accepted, but changes are not yet stored on disk',
        400: 'Bad Request - Invalid request body or parameters',
        401: 'Unauthorized - Write privilege required',
        404: 'Not Found - Specified database or document ID doesn\'t exist',
        409: 'Conflict - Specified revision is not the latest for target document'
      }
    })
  }

  /**
   * Find documents (requires CouchDB >= 2.0.0)
   * @param  {String} dbName
   * @param  {Object} queryObj
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.findDocuments = function findDocuments (dbName, queryObj,stream_or_ct) {
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/_find`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'POST',
      postData: queryObj,
      statusCodes: {
        200: 'OK - Request completed successfully',
        400: 'Bad Request - Invalid request',
        401: 'Unauthorized - Read permission required',
        500: 'Internal Server Error - Query execution error'
      }
    })
  }

  /**
   * Get one or more UUIDs
   * @param  {Number} [count = 1]
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.getUuids = function getUuids (count,stream_or_ct) {
    return request({
      url: `${config.baseUrl}/_uuids?count=${count || 1}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully',
        403: 'Forbidden – Requested more UUIDs than is allowed to retrieve'
      }
    })
  }

  /**
   * Get design document
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {Object} [query]
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.getDesignDocument = function getDesignDocument (dbName, docId, queryObj,stream_or_ct) {
    const queryStr = createQueryString(queryObj)
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/_design/${encodeURIComponent(docId)}${queryStr}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully',
        304: 'Not Modified - Document wasn’t modified since specified revision',
        400: 'Bad Request - The format of the request or revision was invalid',
        401: 'Unauthorized - Read privilege required',
        404: 'Not Found - Document not found'
      }
    })
  }

  /**
   * Get design document info
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.getDesignDocumentInfo = function getDesignDocumentInfo (dbName, docId,stream_or_ct) {
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/_design/${encodeURIComponent(docId)}/_info`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully'
      }
    })
  }

  /**
   * Create a new design document or new revision of an existing design document
   * @param  {String} dbName
   * @param  {Object} doc
   * @param  {String} docId
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.createDesignDocument = function createDesignDocument (dbName, doc, docId,stream_or_ct) {
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/_design${docId && '/'+encodeURIComponent(docId)}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'PUT',
      postData: doc,
      statusCodes: {
        201: 'Created – Document created and stored on disk',
        202: 'Accepted – Document data accepted, but not yet stored on disk',
        400: 'Bad Request – Invalid request body or parameters',
        401: 'Unauthorized – Write privileges required',
        404: 'Not Found – Specified database or document ID doesn’t exists',
        409: 'Conflict – Document with the specified ID already exists or specified revision is not latest for target document'
      }
    })
  }

  /**
   * Delete a named design document
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} rev
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.deleteDesignDocument = function deleteDesignDocument (dbName, docId, rev,stream_or_ct) {
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/_design/${encodeURIComponent(docId)}?rev=${rev}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'DELETE',
      statusCodes: {
        200: 'OK - Document successfully removed',
        202: 'Accepted - Request was accepted, but changes are not yet stored on disk',
        400: 'Bad Request - Invalid request body or parameters',
        401: 'Unauthorized - Write privilege required',
        404: 'Not Found - Specified database or document ID doesn\'t exist',
        409: 'Conflict - Specified revision is not the latest for target document'
      }
    })
  }

  /**
   * Query view or list of view
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} viewName
   * @param  {Object} [query]
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.queryView = function queryView (dbName, viewName, queryObj,stream_or_ct) {
    const queryStr = createQueryString(queryObj)
    let viewPathArr = viewName && viewName.split("/") || []
    let viewPath=(viewPathArr.length<=1
        && `_design/${config.defaultDDocName}/_view/${encodeURIComponent(viewPathArr[0])}/`
        || viewPathArr.length==2 && `_design/${viewPathArr[0].length && encodeURIComponent(viewPathArr[0]) || config.defaultDDocName}/_view/${encodeURIComponent(viewPathArr[1])}/`
        || viewPathArr.length==3 && `_design/${viewPathArr[0].length && encodeURIComponent(viewPathArr[0]) || config.defaultDDocName}/_list/${encodeURIComponent(viewPathArr[1])}/${encodeURIComponent(viewPathArr[2])}`
        || viewPathArr.length==4 && `_design/${viewPathArr[0].length && encodeURIComponent(viewPathArr[0]) || config.defaultDDocName}/_list/${encodeURIComponent(viewPathArr[1])}/${viewPathArr[2].length && encodeURIComponent(viewPathArr[2]) || config.defaultDDocName}/${encodeURIComponent(viewPathArr[3])}`
        || "")
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/${viewPath}${queryStr}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'GET',
      statusCodes: {
        200: 'OK - Request completed successfully'
      }
    })
  }

  /**
   * Bulk docs
   * @param  {String} dbName
   * @param  {Array} docs
   * @param  {Object} [opts]
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.createBulkDocuments = function createBulkDocuments (dbName, docs, opts,stream_or_ct) {
  	if(Array.isArray(docs)){
  		docs = {
	      docs: docs
	    }
	    Object.assign(docs, docs)
  	}
    
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/_bulk_docs`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'POST',
      postData: docs,
      statusCodes: {
        201: 'Created – Document(s) have been created or updated',
        400: 'Bad Request – The request provided invalid JSON data',
        417: 'Expectation Failed – Occurs when all_or_nothing option set as true and at least one document was rejected by validation function',
        500: 'Internal Server Error – Malformed data provided, while it’s still valid JSON'
      }
    })
  }

  // http://docs.couchdb.org/en/latest/api/document/common.html#attachments

  /**
   * Get attachment head
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} attName
   * @param  {String} [rev]
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.getAttachmentHead = function getAttachmentHead (dbName, docId, attName, rev,stream_or_ct) {
    const queryStr = rev ? `?rev=${rev}` : ''
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}/${encodeURIComponent(attName)}${queryStr}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'HEAD',
      statusCodes: {
        200: 'OK - Attachment exists',
        304: 'Not Modified - Attachment wasn’t modified if ETag equals specified If-None-Match header',
        401: 'Unauthorized - Read privilege required',
        404: 'Not Found - Specified database, document or attchment was not found'
      }
    })
  }

  /**
   * get attachment
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} attName
   * @param  {String} [rev]
   * @param  {StreamWritable|Array<StreamWritable>|string} [stream_or_ct] if string(ContentType) or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 also if 'null/false' 'Accept: application/octet-stream' and no auto parse as json
   * @return {Promise}
   */
  couch.getAttachment = function getAttachment (dbName, docId, attName, rev, stream_or_ct) {
    const queryStr = rev ? `?rev=${rev}` : ''
    return Promise.resolve()
      .then(() => request({
        url: `${config.baseUrl}/${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}/${encodeURIComponent(attName)}${queryStr}`,
        [stream_or_ct && ((typeof(stream_or_ct) =="string" || stream==false || stream==null) && "acceptContentType" || "stream") || undefined]: stream_or_ct || "application/octet-stream",
        statusCodes: {
          200: 'OK - Attachment exists',
          304: 'Not Modified - Attachment wasn’t modified if ETag equals specified If-None-Match header',
          401: 'Unauthorized - Read privilege required',
          404: 'Not Found - Specified database, document or attchment was not found'
        }
      })
      .then(response => new Promise(function (resolve, reject) {
        stream_or_ct.on('close', function () {
          return resolve(response)
        })
        stream_or_ct.on('error', function (err) {
          return reject({
            headers: {},
            data: err,
            status: 500,
            message: err.message || 'stream error'
          })
        })
      }))
    )
  }

  /**
   * add attachment
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} attName
   * @param  {String} rev
   * @param  {String} contentType
   * @param  {Buffer|String|Stream} data
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.addAttachment = function addAttachment (dbName, docId, attName, rev, contentType, data,stream_or_ct) {
    const queryStr = rev ? `?rev=${rev}` : ''
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}/${encodeURIComponent(attName)}${queryStr}`,
      method: 'PUT',
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      postContentType: contentType,
      postData: data,
      statusCodes: {
        201: 'OK - Created',  // TODO: check with API again
        202: 'Accepted - Request was but changes are not yet stored on disk',
        401: 'Unauthorized - Write privilege required',
        404: 'Not Found - Specified database, document or attchment was not found',
        409: '409 Conflict – Document’s revision wasn’t specified or it’s not the latest'
      }
    })
  }

  /**
   * delete attachment
   * @param  {String} dbName
   * @param  {String} docId
   * @param  {String} attName
   * @param  {String} rev
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.deleteAttachment = function deleteAttachment (dbName, docId, attName, rev,stream_or_ct) {
    const queryStr = rev ? `?rev=${rev}` : ''
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/${encodeURIComponent(docId)}/${encodeURIComponent(attName)}${queryStr}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'DELETE',
      statusCodes: {
        200: 'OK – Attachment successfully removed',
        202: 'Accepted - Request was but changes are not yet stored on disk',
        400: '400 Bad Request – Invalid request body or parameters',
        401: 'Unauthorized - Write privilege required',
        404: 'Not Found - Specified database, document or attchment was not found',
        409: '409 Conflict – Document’s revision wasn’t specified or it’s not the latest'
      }
    })
  }

  /**
   * create index (requires CouchDB >= 2.0.0)
   * @param  {String} dbName
   * @param  {Object} queryObj
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.createIndex = function createIndex (dbName, queryObj,stream_or_ct) {
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/_index`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'POST',
      postData: queryObj,
      statusCodes: {
        200: 'OK - Index created successfully or already exists',
        400: 'Bad Request - Invalid request',
        401: 'Unauthorized - Admin permission required',
        500: 'Internal Server Error - Execution error'
      }
    })
  }

  /**
   * get index (requires CouchDB >= 2.0.0)
   * @param  {String} dbName
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.getIndex = function getIndex (dbName,stream_or_ct) {
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/_index`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'GET',
      statusCodes: {
        200: 'OK - Success',
        400: 'Bad Request - Invalid request',
        401: 'Unauthorized - Read permission required',
        500: 'Internal Server Error - Execution error'
      }
    })
  }

  /**
   * delete index (requires CouchDB >= 2.0.0)
   * @param  {String} dbName
   * @param  {String} docId - design document id
   * @param  {String} name - index name
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.deleteIndex = function deleteIndex (dbName, docId, name,stream_or_ct) {
    return request({
      url: `${config.baseUrl}/${encodeURIComponent(dbName)}/_index/${encodeURIComponent(docId)}/json/${encodeURIComponent(name)}`,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      method: 'DELETE',
      statusCodes: {
        200: 'OK - Success',
        400: 'Bad Request - Invalid request',
        401: 'Unauthorized - Writer permission required',
        404: 'Not Found - Index not found',
        500: 'Internal Server Error - Execution error'
      }
    })
  }

  /**
   * generic request function
   * @param  {String} url    e.g. http://localhost:5948/_all_dbs
   * @param  {StreamWritable|Array<StreamWritable>|null|string} [stream_or_ct] if null or undefined then return "data" in Promise 
   			 if StreamWritable|Array<StreamWritable> pipe it to http req
   			 if 'null|false' not automate parse as json
   			 also if is string then set value as acceptContentType
   * @return {Promise}
   */
  couch.getUrl = function (url,stream_or_ct) {
    return request({
      url: url,
      [stream_or_ct && typeof(stream_or_ct) !="string" && "stream" || ((stream_or_ct===undefined) && undefined || "acceptContentType")]: stream_or_ct,
      methode: 'GET'
    })
  }

  return couch
}

Object.keys(module.exports()).forEach(func => {
  module.exports[func] = () => {
    throw new TypeError('couchdb-promises 2.x now returns a factory function - see documentation for details')
  }
})
