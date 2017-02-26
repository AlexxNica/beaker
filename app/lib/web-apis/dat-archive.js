import {ipcRenderer} from 'electron'
import rpc from 'pauls-electron-rpc'
import datArchiveManifest from '../api-manifests/external/dat-archive'
import {DAT_URL_REGEX} from '../const'

// create the dat rpc api
const dat = rpc.importAPI('dat-archive', datArchiveManifest, { timeout: false, noEval: true })

export default class DatArchive {
  constructor(url) {
    // basic URL validation
    if (!url || typeof url !== 'string') {
      throw new Error('Invalid dat:// URL')
    }
    var key = DAT_URL_REGEX.exec(url)
    if (!key[1]) {
      throw new Error('Invalid dat:// URL')
    }
    url = 'dat://' + key[1]

    // load into the 'active' (in-memory) cache
    dat.loadArchive(url)

    // define this.url as a frozen getter
    Object.defineProperty(this, 'url', {
      enumerable: true,
      value: url
    })
  }

  static create (opts={}) {
    return dat.createArchive(opts)
      .then(newUrl => new DatArchive(newUrl))
  }

  static fork (url, opts={}) {
    url = (typeof url.url === 'string') ? url.url : url
    return dat.forkArchive(url, opts)
      .then(newUrl => new DatArchive(newUrl))
  }

  getInfo(opts=null) {
    return dat.getInfo(this.url, opts)
  }

  updateManifest(manifest) {
    return dat.updateManifest(this.url, manifest)
  }

  stat(path, opts=null) {
    const url = joinPath(this.url, path)
    return dat.stat(url, opts)
  }

  readFile(path, opts=null) {
    const url = joinPath(this.url, path)
    return dat.readFile(url, opts)
  }

  writeFile(path, data, opts=null) {
    const url = joinPath(this.url, path)
    return dat.writeFile(url, data, opts)
  }

  deleteFile(path) {
    const url = joinPath(this.url, path)
    return dat.deleteFile(url)
  }

  download(path='/', opts={}) {
    const url = joinPath(this.url, path)
    return dat.download(url, opts)
  }

  listFiles(path, opts) {
    const url = joinPath(this.url, path)
    return dat.listFiles(url, opts)
  }

  createDirectory(path) {
    const url = joinPath(this.url, path)
    return dat.createDirectory(url)
  }

  deleteDirectory(path) {
    const url = joinPath(this.url, path)
    return dat.deleteDirectory(url)
  }

  createFileActivityStream(pathSpec=null) {
    return dat.createFileActivityStream(this.url, pathSpec)
  }

  createNetworkActivityStream(opts) {
    return dat.createNetworkActivityStream(this.url)
  }

  static importFromFilesystem(opts={}) {
    return dat.importFromFilesystem(opts)
  }
  
  static exportToFilesystem(opts={}) {
    return dat.exportToFilesystem(opts)
  }
  
  static exportToArchive(opts={}) {
    return dat.exportToArchive(opts)
  }
}

function joinPath (url, path) {
  if (path.charAt(0) === '/') return url + path
  return url + '/' + path
}
