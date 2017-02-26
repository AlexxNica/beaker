import {ipcRenderer} from 'electron'
import rpc from 'pauls-electron-rpc'
import libraryManifest from '../api-manifests/external/library'
import {EventTarget, bindEventStream} from './event-target'

export default function setup() {
  // create the api
  const libraryAPI = new EventTarget()
  const libraryRPC = rpc.importAPI('library', libraryManifest, { timeout: false, noEval: true })
  libraryAPI.list = libraryRPC.list
  libraryAPI.get = libraryRPC.get
  libraryAPI.add = libraryRPC.add
  libraryAPI.remove = libraryRPC.remove
  bindEventStream(libraryRPC.createEventStream(), libraryAPI)
  return libraryAPI
}