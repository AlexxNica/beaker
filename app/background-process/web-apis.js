import { ipcMain } from 'electron'
import beakerBrowser from '../lib/api-manifests/internal/browser'
import beakerBookmarks from '../lib/api-manifests/internal/bookmarks'
import beakerDownloads from '../lib/api-manifests/internal/downloads'
import beakerHistory from '../lib/api-manifests/internal/history'
import beakerSitedata from '../lib/api-manifests/internal/sitedata'
import datInternalAPI from '../lib/api-manifests/internal/dat-internal'
import dat from '../lib/api-manifests/external/dat'

// exported api
// =

export function setup () {
  // register a message-handler for setting up the client
  // - see lib/fg/import-web-apis.js
  ipcMain.on('get-web-api-manifests', (event, scheme) => {
    var protos

    // hardcode the beaker: scheme, since that's purely for internal use
    if (scheme === 'beaker:') {
      protos = {
        beakerBrowser,
        beakerBookmarks,
        beakerDownloads,
        beakerHistory,
        beakerSitedata,
        datInternalAPI
      }
      event.returnValue = protos
      return
    }

    event.returnValue = {}
  })
}
