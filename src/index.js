require('babel-polyfill')
const {
  FusionEmitter,
  ListenerSet,
  validIndexValue,
  promiseError,
} = require('./utility.js')

const PROTOCOL_VERSION = 'rethinkdb-fusion-v0'

function responseEvent(id){
  return `response:${id}`
}
function errorEvent(id){
  return `error:${id}`
}


var fusionCount = 0

class Fusion extends FusionEmitter {
  constructor(host, {secure: secure=true}={}){
    super(`Fusion(${fusionCount++})`)

    // Allow calling a fusion object
    let self = name => this.collection(name)
    Object.setPrototypeOf(self, this)

    this.host = host
    this.secure = secure
    this.requestCounter = 0
    this.socket = new FusionSocket(host, secure)
    this.listenerSet = ListenerSet.absorbEmitter(this.socket)
      .onceAndDispose('error', (err) => this.emit('error', err, self))
      .on('connected', () => this.emit('connected', self))
      .on('disconnected', () => this.emit('disconnected', self))
    // send handshake
    this.handshakeResponse = this.socket.getPromise('connected').then(() => {
      let reqId = this.requestCounter++
      this.socket.send({request_id: reqId})
      return this.socket.getPromise(responseEvent(reqId)).then((res) => {
        return res
      })
    }).catch(() => {})
    return self
  }

  dispose(reason='Fusion object disposed'){
    // The listenerSet owns the fusionSocket, so will dispose of it.
    return this.listenerSet.dispose(reason)
  }

  collection(collectionName){
    return new Collection(this, collectionName)
  }

  writeOp(opType, collectionName, documents){
    let command = {data: documents, collection: collectionName}
    return this._send(opType, command).intoCollectingPromise('response')
  }

  query(data){
    return this._send('query', data).intoCollectingPromise('response')
  }

  subscribe(query, updates=true){
    if(updates){
      return this._subscribe(query)
    }else{
      return this._send('query', query)
    }
  }

  endSubscription(requestId){
    return this.handshakeResponse.then(handshake => {
      this.socket.send({request_id: requestId, type: 'end_subscription'})
    })
  }

  _send(type, data){
    let requestId = this.requestCounter++
    let req = {type: type, options: data, request_id: requestId}
    this.handshakeResponse.then((handshake) => {
      this.socket.send(req)
    })
    return new RequestEmitter(requestId, this, 'query')
  }

  // Subscription queries, only handles returning an emitter
  _subscribe(query){
    let requestId = this.requestCounter++
    let req = {type: 'subscribe', options: query, request_id: requestId}
    this.handshakeResponse.then((handshake) => this.socket.send(req))
    return new RequestEmitter(requestId, this, 'subscribe')
  }

}

var socketCount = 0

class FusionSocket extends FusionEmitter {
  // Wraps native websockets in an EventEmitter, and deals with some
  // simple protocol level things like serializing from/to JSON, and
  // emitting events on request_ids
  constructor(host, secure=true){
    super(`FusionSocket(${socketCount++})`)
    let hostString = (secure ? 'wss://' : 'ws://') + host
    this._ws = new WebSocket(hostString, PROTOCOL_VERSION)
    this._openWs = new Promise((resolve, reject) => {
      this._ws.onopen = (event) => {
        this.emit('connected', event)
        resolve(this._ws)
      }
      this._ws.onerror = (event) => {
        this.emit('error', event)
        reject(event)
      }
      this._ws.onclose = (event) => {
        this.emit('disconnected', event)
        reject(event)
      }
    })
    this._ws.onmessage = (event) => {
      let data = JSON.parse(event.data)
      if(data.request_id === undefined){
        this.emit("error", "Request id undefined", data)
      }else if(data.error !== undefined){
        this.emit(errorEvent(data.request_id), data)
      }else {
        this.emit(responseEvent(data.request_id), data)
      }
    }
  }

  send(message){
    if(typeof message !== 'string'){
      message = JSON.stringify(message)
    }
    this._openWs.then((ws) => ws.send(message))
  }

  dispose(reason='FusionSocket disposed'){
    this._ws.close(1000, reason)
    return this.getPromise('disconnected')
  }

}

// These are created for requests, will only get messages for the
// particular request id. Has extra methods for closing the request,
// and for creating promises that resolve or reject based on events
// from this emitter
class RequestEmitter extends FusionEmitter {
  constructor(requestId, fusion, queryType){
    super(`RequestEmitter(${requestId})`)
    this.fusion = fusion
    this.requestId = requestId
    this.queryType = queryType
    this.remoteListeners = ListenerSet.onEmitter(this.fusion.socket)
    //Forwards on fusion events to this emitter's listeners
    this.remoteListeners
      .fwd('connected', this)
      .fwd('disconnected', this)
      .onceAndDispose(errorEvent(requestId), (err) => {
        this.emit('error', err)
      }).on(responseEvent(requestId), (response) => {
        if(Array.isArray(response.data)){
          let emitted = false
          response.data.forEach(changeObj => {
            emitted = this._emitChangeEvent(changeObj)
          })
          if(!emitted){
              this.emit('response', response.data)
          }
        }else if(response.data !== undefined){
          this.emit("response", response.data)
        }
        if(response.state === 'synced'){
          this.emit('synced')
        }else if(response.state === 'complete'){
          this.emit('complete')
        }
      }).disposeOn('error')
  }

  _emitChangeEvent(changeObj){
    if(changeObj.new_val === undefined && changeObj.old_val === undefined){
      return false
    }
    if(changeObj.new_val !== null && changeObj.old_val !== null){
      if(this.listenerCount('changed') === 0){
        this.emit('removed', changeObj.old_val)
        this.emit('added', changeObj.new_val)
      }else{
        this.emit('changed', changeObj.new_val, changeObj.old_val)
      }
      return true
    }else if(changeObj.new_val !== null && changeObj.old_val === null){
      this.emit('added', changeObj.new_val)
      return true
    }else if(changeObj.new_val === null && changeObj.old_val !== null){
      this.emit('removed', changeObj.old_val)
      return true
    }else{
      return false
    }
  }
  dispose(reason=`RequestEmitter for ${this.requestId} disposed`){
    if(this.type === 'subscription'){
      return this.fusion.endSubscription(this.requestId)
        .then(() => this.getPromise('complete'))
        .then(() => this.remoteListeners.dispose(reason))
    }else{
      return this.remoteListeners.dispose(reason)
    }
  }
}


class MockConnection extends Fusion {
  constructor(hostString){
    super()
    this.hostString = hostString;
    this.docs = [];
    this.promises = {};
    this.emitters = {};
    this.requestCounter = 0;
  }

  send(type, data){
    //Basically, don't actually send anything just store it in an array,
    // inefficient search and no error handling but fine for mocking

    switch(type){
    case 'update':
      this.docs.forEach(function(doc, index){
        if (doc.id == data.id){
          this.data[index] = data;
        }
      });
      break;
    case 'remove':
      this.docs.forEach(function(doc, index){
        if (doc.id == data.id){
          this.data = this.data.splice(index);
        }
      });
      break;
    case 'store_replace':
    case 'store_error':
      this.docs.push(data);
      break;
    }

    return Promise.resolve(true);
  }

  _onOpen(event){
    for(let emitter of this.emitters){
      emitter.emit('reconnected', event);
    }
  }
}


class TermBase {

  constructor(fusion){
    this.fusion = fusion
  }

  subscribe(updates=true){
    // should create a changefeed query, return eventemitter
    return this.fusion.subscribe(this.query, updates)
  }

  value(){
    // return promise with no changefeed
    return this.fusion.query(this.query)
  }
}

class Collection extends TermBase {

  constructor(fusion, collectionName){
    super(fusion)
    this._collectionName = collectionName
    this.query = {collection: collectionName, field_name: 'id'}
  }

  find(id, {field: field='id'}={}){
    return new Find(this.fusion, this.query, id, field)
  }

  findAll(...fieldValues){
    var fieldName = 'id'
    if(arguments.length > 0){
      let last = fieldValues.slice(-1)[0]
      if(!!last && typeof last === 'object' && last.field !== undefined){
        fieldName = last.field
        fieldValues = fieldValues.slice(0, -1)
      }
    }
    return new FindAll(this.fusion, this.query, fieldValues, fieldName)
  }

  between(minVal, maxVal, field='id'){
    return new Between(this.fusion, this.query, minVal, maxVal,field)
  }

  order(field='id', ascending=true){
    return new Order(this.fusion, this.query, field, ascending)
  }

  store(documents){
    return this._writeOp('store', documents)
  }

  upsert(documents){
    return this._writeOp('upsert', documents)
  }

  insert(documents){
    return this._writeOp('insert', documents)
  }

  replace(documents){
    return this._writeOp('replace', documents)
  }

  update(documents){
    return this._writeOp('update', documents)
  }

  remove(documentOrId){
    if(arguments.length > 1){
      return promiseError("remove takes exactly one argument")
    }
    if(documentOrId === undefined){
      return promiseError("remove must be given an argument")
    }
    if(documentOrId === null){
      return promiseError("remove must receive a non-null argument")
    }
    if(validIndexValue(documentOrId)){
      documentOrId = {id: documentOrId}
    }
    return this._writeOp('remove', [documentOrId]).then(() => undefined)
  }

  removeAll(documentsOrIds){
    if(!Array.isArray(documentsOrIds)){
      return promiseError("removeAll takes an array as an argument")
    }
    if(arguments.length > 1){
      return promiseError("removeAll only takes one argument (an array)")
    }
    documentsOrIds = documentsOrIds.map(item => {
      if(validIndexValue(item)){
        return {id: item}
      }else{
        return item
      }
    })
    return this._writeOp('remove', documentsOrIds).then(() => undefined)
  }

  _writeOp(name, documents){
    if(documents == null){
      return promiseError(`${name} must receive a non-null argument`)
    }else if(!Array.isArray(documents)){
      documents = [documents]
    }else if(documents.length === 0){
      // Don't bother sending no-ops to the server
      return Promise.resolve([])
    }
    return this.fusion.writeOp(name, this._collectionName, documents)
  }
}

class FindAll extends TermBase {
  constructor(fusion, query, fieldValues, fieldName){
    super(fusion)
    this._values = fieldValues
    this._name = fieldName
    this.query = Object.assign({}, query, {
      selection: {type: 'find_all', args: fieldValues},
      field_name: fieldName
    })
  }

  value(){
    if(this._values.length === 0){
      return Promise.resolve([])
    }else{
      return super.value()
    }
  }

  order(field='id', ascending=true){
    return new Order(this.fusion, this.query, field, ascending)
  }

  limit(size){
    return new Limit(this.fusion, this.query, size);
  }
}

class Find extends TermBase {
  constructor(fusion, query, docId, fieldName){
    super(fusion)
    this._id = docId
    this._fieldName = fieldName
    this.query = Object.assign({}, query, {
      selection: {type: 'find', args: [docId]},
      field_name: fieldName,
    })
  }

  value(){
    return super.value().then(val => {
      if(val != undefined){
        return val[0] || null
      }else{
        return null
      }
    })
  }
}

class Between extends TermBase {
  constructor(fusion, query, minVal, maxVal, fieldName){
    super(fusion)
    this._minVal = minVal
    this._maxVal = maxVal
    this._field = fieldName
    this.query = Object.assign({}, query, {
      selection: {type: 'between', args: [minVal, maxVal]},
      field_name: fieldName
    })
  }

  limit(size){
    return new Limit(this.fusion, this.query, size);
  }
}

class Order {
  constructor(fusion, query, fieldName, ascending){
    this.fusion = fusion
    this._field = fieldName
    this.query = Object.assign({}, query, {
      order: ascending ? 'ascending' : 'descending',
      field_name: fieldName
    })
  }

  limit(size){
    return new Limit(this.fusion, this.query, size)
  }

  between(minVal, maxVal){
    // between is forced to have the same field as this term
    return new Between(this.fusion, this.query, minVal, maxVal, this.field)
  }
}

class Limit extends TermBase {
  constructor(fusion, query, size){
    super(fusion)
    this._size = size
    this.query = Object.assign({}, query, {limit: size})
  }
}

module.exports = Fusion
