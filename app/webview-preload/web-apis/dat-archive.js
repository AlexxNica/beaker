import {ipcRenderer} from 'electron'
import rpc from 'pauls-electron-rpc'
import datManifest from '../../lib/api-manifests/external/dat'

// create the dat rpc api
const dat = rpc.importAPI('dat', datManifest, { timeout: false, noEval: true })

export default class DatArchive {
  constructor(url) {
    // verify URL is valid
    // TODO

    // load into the 'active' (in-memory) cache
    dat.loadArchive(url)

    // define this.url as a frozen getter
    Object.defineProperty(this, 'url', {
      enumerable: true,
      value: url
    })
  }

  static async create (opts=null) {
    var newUrl = await dat.createArchive(opts)
    return new DatArchive(newUrl)
  }

  static async fork (url, opts=null) {
    url = (typeof url.url === 'string') ? url.url : url
    var newUrl = await dat.forkArchive(url, opts)
    return new DatArchive(newUrl)
  }

  async getInfo(opts=null) {
    return dat.getInfo(this.url, opts)
  }

  async updateManifest(info) {
    return dat.updateManifest(this.url, info)
  }

  async stat(path, opts=null) {
    const url = makeUrl(this.url, path)
    return dat.stat(url, opts)
  }

  async readFile(path, opts=null) {
    const url = makeUrl(this.url, path)
    return dat.readFile(url, opts)
  }

  async writeFile(path, data, opts=null) {
    const url = makeUrl(this.url, path)
    return dat.writeFile(url, data, opts)
  }

  async deleteFile(path) {
    const url = makeUrl(this.url, path)
    return dat.deleteFile(url)
  }

  async download(path, opts) {
    const url = makeUrl(this.url, path)
    return dat.download(url, opts)
  }

  async listFiles(path, opts) {
    const url = makeUrl(this.url, path)
    return dat.listFiles(url, opts)
  }

  async createDirectory(path) {
    const url = makeUrl(this.url, path)
    return dat.createDirectory(url)
  }

  async deleteDirectory(path) {
    const url = makeUrl(this.url, path)
    return dat.deleteDirectory(url)
  }

  // createFileActivityStream(opts) {
  //   // TODO
  // }

  // createNetworkActivityStream(opts) {
  //   // TODO
  // }

  // static async importFromFilesystem(opts) {
  //   // TODO
  // }
  
  // static async exportToFilesystem(opts) {
  //   // TODO
  // }
  
  // static async exportToArchive(opts) {
  //   // TODO
  // }
}