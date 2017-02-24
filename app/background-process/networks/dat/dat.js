import {shell} from 'electron'
import emitStream from 'emit-stream'
import EventEmitter from 'events'
import pump from 'pump'
import multicb from 'multicb'
import datEncoding from 'dat-encoding'
import pify from 'pify'
import pda from 'pauls-dat-api'
var debug = require('debug')('dat')
import trackArchiveEvents from './track-archive-events'
import {debounce, cbPromise} from '../../../lib/functions'
import {grantPermission} from '../../ui/permissions'

// db modules
import * as archivesDb from '../../dbs/archives'
import hyperdrive from 'hyperdrive'

// network modules
import swarmDefaults from 'datland-swarm-defaults'
import discoverySwarm from 'discovery-swarm'
import hyperImport from 'hyperdrive-import-files'
const datDns = require('dat-dns')()

// file modules
import path from 'path'
import fs from 'fs'
import raf from 'random-access-file'
import mkdirp from 'mkdirp'
import getFolderSize from 'get-folder-size'

// constants
// =

import {DAT_MANIFEST_FILENAME, DAT_URL_REGEX} from '../../../lib/const'

// globals
// =

var drive // hyperdrive instance
var archives = {} // memory cache of archive objects. key -> archive
var archivesByDiscoveryKey = {} // mirror of the above cache, but discoveryKey -> archive
var archivesEvents = new EventEmitter()

// exported API
// =

export function setup () {
  drive = hyperdrive(archivesDb.getLevelInstance())

  // wire up event handlers
  archivesDb.on('update:archive-user-settings', (key, settings) => {
  archivesEvents.emit('update-user-settings', { key, isSaved: settings.isSaved })
    configureArchive(key, settings)
  })

  // load and configure all saved archives
  archivesDb.queryArchiveUserSettings({ isSaved: true }).then(
    archives => archives.forEach(a => configureArchive(a.key, a)),
    err => console.error('Failed to load networked archives', err)
  )
}

// re-exports
//

export const resolveName = datDns.resolveName
export const setArchiveUserSettings = archivesDb.setArchiveUserSettings
export const getGlobalSetting = archivesDb.getGlobalSetting
export const setGlobalSetting = archivesDb.setGlobalSetting

// archive creation and mutation
// =

export async function createNewArchive (manifest) {
  // create the archive
  var archive = loadArchive(null)
  var key = datEncoding.toStr(archive.key)
  manifest.url = `dat://${key}/`

  // write the manifest then resolve
  await pda.writeManifest(archive, manifest)

  // write the user settings
  await setArchiveUserSettings(key, { isSaved: true })

  // write the perms
  if (createdBy && createdBy.url) grantPermission('modifyDat:' + key, createdBy.url)

  return manifest.url
}

export async function forkArchive (srcArchiveUrl, manifest={}) {
  srcArchiveUrl = fromKeyToURL(srcArchiveUrl)

  // get the old archive
  var dstArchive
  var srcArchive = getArchive(srcArchiveUrl)
  if (!srcArchive) {
    throw new Error('Invalid archive key')
  }

  // fetch old archive meta
  var meta = await archivesDb.getArchiveMeta(srcArchiveUrl)

  // override any manifest data
  var dstArchiveManifest = {
    title: (manifest.title) ? manifest.title : meta.title,
    description: (manifest.description) ? manifest.description : meta.description,
    createdBy: manifest.createdBy,
    forkOf: (meta.forkOf || []).concat(srcArchiveUrl)
  }

  // create the new archive
  var dstArchiveUrl = await createNewArchive(dstArchiveManifest)
  var dstArchive = getArchive(dstArchiveKey)

  // copy files
  await pda.exportArchiveToArchive({
    srcArchive,
    dstArchive,
    skipUndownloadedFiles: true,
    ignore: ['/dat.json']
  })
  return dstArchiveUrl
}

// TODO move to web api
export function updateArchiveManifest (key, updates) {
  var archive = getArchive(key)
  if (!archive) {
    return Promise.reject(new Error('Invalid archive key'))
  }
  return pda.updateManifest(archive, updates)
}

// TODO move to web api
export function writeArchiveFileFromData (key, path, data, opts) {
  var archive = getArchive(key)
  if (!archive) {
    return Promise.reject(new Error('Invalid archive key'))
  }
  return pda.writeFile(archive, path, data, opts)
}

// TODO move to web api
export function writeArchiveFileFromPath (dstKey, opts) {
  var dstArchive = getArchive(dstKey)
  if (!dstArchive) {
    return Promise.reject(new Error('Invalid archive key'))
  }
  return pda.exportFilesystemToArchive({
    srcPath: opts.src,
    dstArchive,
    dstPath: opts.dst,
    ignore: opts.ignore,
    dryRun: opts.dryRun,
    inplaceImport: true,
    skipUndownloadedFiles: true
  })
}

// TODO move to web api
export function exportFileFromArchive (srcKey, srcPath, dstPath) {
  var srcArchive = getArchive(srcKey)
  if (!srcArchive) {
    return Promise.reject(new Error('Invalid archive key'))
  }
  return pda.exportArchiveToFilesystem({
    srcArchive,
    srcPath,
    dstPath,
    overwriteExisting: true
  })
}

// archive management
// =

// load archive and set the swarming behaviors
export function configureArchive (key, settings) {
  var download = settings.isSaved
  var upload = settings.isSaved
  var archive = getOrLoadArchive(key, { noSwarm: true })
  var wasUploading = (archive.userSettings && archive.userSettings.isSaved)
  archive.userSettings = settings
  archivesEvents.emit('update-archive', { key, isUploading: upload, isDownloading: download })

  archive.open(() => {
    if (!archive.isSwarming) {
      // announce
      joinSwarm(archive)
    } else if (upload !== wasUploading) {
      // reset the replication feeds
      debug('Resetting the replication stream with %d peers', archive.metadata.peers.length)
      archive.metadata.peers.forEach(({ stream }) => {
        archive.unreplicate(stream)
        // HACK
        // some state needs to get reset, but we havent figured out what event to watch for
        // so... wait 3 seconds
        // https://github.com/beakerbrowser/beaker/issues/205
        // -prf
        setTimeout(() => archive.replicate({ stream, download: true, upload }), 3e3)
      })
    }
  })
}

export function loadArchive (key, { noSwarm } = {}) {
  // validate key
  if (key !== null && (!Buffer.isBuffer(key) || key.length !== 32)) {
    return
  }

  // create the archive instance
  var archive = drive.createArchive(key, {
    live: true,
    sparse: true,
    verifyReplicationReads: true,
    file: name => raf(path.join(archivesDb.getArchiveFilesPath(archive), name))
  })
  archive.userSettings = null // will be set by `configureArchive` if at all
  mkdirp.sync(archivesDb.getArchiveFilesPath(archive)) // ensure the folder exists
  cacheArchive(archive)
  if (!noSwarm) joinSwarm(archive)

  // prioritize the entire metadata feed, but leave content to be downloaded on-demand
  archive.metadata.prioritize({priority: 0, start: 0, end: Infinity})

  // wire up events
  archive.pullLatestArchiveMeta = debounce(() => pullLatestArchiveMeta(archive), 1e3)
  trackArchiveEvents(archivesEvents, archive)

  return archive
}

export function cacheArchive (archive) {
  archives[datEncoding.toStr(archive.key)] = archive
  archivesByDiscoveryKey[datEncoding.toStr(archive.discoveryKey)] = archive
}

export function getArchive (key) {
  key = fromURLToKey(key)
  return archives[key]
}

export function getActiveArchives () {
  return archives
}

export function getOrLoadArchive (key, opts) {
  var archive = getArchive(key)
  if (archive) {
    return archive
  }
  return loadArchive(datEncoding.toBuf(fromURLToKey(key)), opts)
}

export function openInExplorer (key) {
  var folderpath = archivesDb.getArchiveFilesPath(key)
  debug('Opening in explorer:', folderpath)
  shell.openExternal('file://' + folderpath)
}

// archive fetch/query
// =

export async function queryArchives (query) {
  // run the query
  var archiveInfos = await archivesDb.queryArchiveUserSettings(query, { includeMeta: true })

  // attach some live data
  archiveInfos.forEach(archiveInfo => {
    var archive = getArchive(archiveInfo.key)
    if (archive) {
      archiveInfo.peers = archive.metadata.peers.length
    }
  })
  return archiveInfos
}

export async function getArchiveDetails (name, opts = {}) {
  // get the archive
  var key = await datDns.resolveName(name)
  var archive = getOrLoadArchive(key)

  // fetch archive data
  var [meta, userSettings, entries] = await Promise.all([
    archivesDb.getArchiveMeta(key),
    archivesDb.getArchiveUserSettings(key),
    (opts.entries) ? new Promise(resolve => archive.list((err, entries) => resolve(entries))) : null
  ])

  // attach additional data
  meta.userSettings = userSettings
  meta.entries = entries

  // metadata for history view
  meta.blocks = archive.metadata.blocks
  meta.metaSize = archive.metadata.bytes
  meta.contentKey = archive.content.key

  if (opts.contentBitfield) {
    meta.contentBitfield = archive.content.bitfield.buffer
  }
  meta.peers = archive.metadata.peers.length
  return meta
}

export async function getArchiveStats (key) {
  // fetch archive
  var archive = getArchive(key)
  if (!archive) {
    throw new Error('Invalid archive key')
  }

  // fetch the archive entries
  var entries = await pify(archive.list.bind(archive))()

  // TEMPORARY
  // remove duplicates
  // this is only needed until hyperdrive fixes its .list()
  // see https://github.com/mafintosh/hyperdrive/pull/99
  // -prf
  var entriesDeDuped = {}
  entries.forEach(entry => { entriesDeDuped[entry.name] = entry })
  entries = Object.keys(entriesDeDuped).map(name => entriesDeDuped[name])

  // tally the current state
  var stats = {
    peers: archive.metadata.peers.length,
    filesTotal: 0,
    meta: {
      blocksProgress: archive.metadata.blocks - archive.metadata.blocksRemaining(),
      blocksTotal: archive.metadata.blocks
    },
    content: {
      bytesTotal: 0,
      blocksProgress: 0,
      blocksTotal: 0
    }
  }
  entries.forEach(entry => {
    stats.content.bytesTotal += entry.length
    stats.content.blocksProgress += archive.countDownloadedBlocks(entry)
    stats.content.blocksTotal += entry.blocks
    stats.filesTotal++
  })
  return stats
}

// archive networking
// =

// put the archive into the network, for upload and download
export function joinSwarm (key, opts) {
  var archive = (typeof key == 'object' && key.discoveryKey) ? key : getArchive(key)
  if (!archive || archive.isSwarming) return

  var keyStr = datEncoding.toStr(archive.key)
  var swarm = discoverySwarm(swarmDefaults({
    hash: false,
    utp: true,
    tcp: true,
    stream: (info) => {
      var dkeyStr = datEncoding.toStr(archive.discoveryKey)
      var chan = dkeyStr.slice(0,6) + '..' + dkeyStr.slice(-2)
      var keyStrShort = keyStr.slice(0,6) + '..' + keyStr.slice(-2)
      debug('new connection chan=%s type=%s host=%s key=%s', chan, info.type, info.host, keyStrShort)

      // create the replication stream
      var stream = archive.replicate({
        download: true,
        upload: (archive.userSettings && archive.userSettings.isSaved)
      })

      // timeout the connection after 5s if handshake does not occur
      var TO = setTimeout(() => {
        debug('handshake timeout chan=%s type=%s host=%s key=%s', chan, info.type, info.host, keyStrShort)
        stream.destroy(new Error('Timed out waiting for handshake'))
      }, 5000)
      stream.once('handshake', () => clearTimeout(TO))

      // debugging
      stream.on('error', err => debug('error chan=%s type=%s host=%s key=%s', chan, info.type, info.host, keyStrShort, err))
      stream.on('close', err => debug('closing connection chan=%s type=%s host=%s key=%s', chan, info.type, info.host, keyStrShort))
      return stream
    }
  }))
  swarm.listen()
  swarm.on('error', err => debug('Swarm error for', keyStr, err))
  swarm.join(archive.discoveryKey)

  debug('Swarming archive', datEncoding.toStr(archive.key), 'discovery key', datEncoding.toStr(archive.discoveryKey))
  archive.isSwarming = true
  archive.swarm = swarm
}

// take the archive out of the network
export function leaveSwarm (key, cb) {
  var archive = (typeof key == 'object' && key.discoveryKey) ? key : getArchive(key)
  if (!archive || !archive.isSwarming) return

  var keyStr = datEncoding.toStr(archive.key)
  var swarm = archive.swarm

  debug('Unswarming archive %s disconnected %d peers', keyStr, archive.metadata.peers.length)
  archive.unreplicate() // stop all active replications
  swarm.leave(archive.discoveryKey)
  swarm.destroy()
  delete archive.swarm
  archive.isSwarming = false
}

// prioritize all current entries for download
export async function downloadArchive (key) {
  return cbPromise(cb => {
    // get the archive
    var archive = getArchive(key)
    if (!archive) cb(new Error('Invalid archive key'))

    // get the current file listing
    archive.list((err, entries) => {
      if (err) return cb(err)

      // TEMPORARY
      // remove duplicates
      // this is only needed until hyperdrive fixes its .list()
      // see https://github.com/mafintosh/hyperdrive/pull/99
      // -prf
      var entriesDeDuped = {}
      entries.forEach(entry => { entriesDeDuped[entry.name] = entry })
      entries = Object.keys(entriesDeDuped).map(name => entriesDeDuped[name])

      // download the enties
      var done = multicb()
      entries.forEach(entry => {
        if (entry.blocks > 0) {
          archive.download(entry, done())
        }
      })
      done(() => cb())
    })
  })
}

// prioritize an entry for download
export function downloadArchiveEntry (key, name, opts) {
  var archive = getArchive(key)
  if (!archive) {
    Promise.reject(new Error('Invalid archive key'))
  }
  return pda.download(archive, name, opts)
}

export function archivesEventStream () {
  return emitStream(archivesEvents)
}

// internal methods
// =

// read metadata for the archive, and store it in the meta db
function pullLatestArchiveMeta (archive) {
  var key = archive.key.toString('hex')
  var done = multicb({ pluck: 1, spread: true })

  // open() just in case (we need .blocks)
  archive.open(() => {
    // read the archive metafiles
    pda.readManifest(archive, done())

    // calculate the size on disk
    var sizeCb = done()
    getFolderSize(archivesDb.getArchiveFilesPath(archive), (_, size) => {
      sizeCb(null, size)
    })

    done((_, manifest, size) => {
      manifest = manifest || {}
      var { title, description, author, version, forkOf, createdBy } = manifest
      var mtime = Date.now() // use our local update time
      var isOwner = archive.owner
      size = size || 0

      // write the record
      var update = { title, description, author, version, forkOf, createdBy, mtime, size, isOwner }
      debug('Writing meta', update)
      archivesDb.setArchiveMeta(key, update).then(
        () => {
          update.key = key
          archivesEvents.emit('update-archive', update)
        },
        err => debug('Error while writing archive meta', key, err)
      )
    })
  })
}

function fromURLToKey (url) {
  if (Buffer.isBuffer(url)) {
    return url
  }
  if (url.startsWith('dat://')) {
    url = DAT_URL_REGEX.exec(url)[1]
  }
  return url
}

function fromKeyToURL (key) {
  if (typeof key !== 'string') {
    key = datEncoding.toStr(key)
  }
  if (!key.startsWith('dat://')) {
    return `dat://${key}/`
  }
  return key
}
