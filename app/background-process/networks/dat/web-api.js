import path from 'path'
import {parse as parseURL} from 'url'
import pda from 'pauls-dat-api'
import * as dat from './dat'
import * as archivesDb from '../../dbs/archives'
import * as sitedataDb from '../../dbs/sitedata'
import {queryPermission, requestPermission} from '../../ui/permissions'
import { 
  DAT_HASH_REGEX,
  DAT_QUOTA_DEFAULT_BYTES_ALLOWED,
  DAT_VALID_PATH_REGEX,

  UserDeniedError,
  QuotaExceededError,
  ArchiveNotWritableError,
  ArchiveNotSavedError,
  InvalidURLError,
  FileNotFoundError,
  ProtectedFileNotWritableError,
  InvalidPathError
} from '../../../lib/const'

const DEFAULT_TIMEOUT = 5e3

// exported api
// =

export default {
  async createArchive({title, description} = {}) {
    // ask the user
    var decision = await requestPermission('createDat', this.sender, {title})
    if (decision === false) throw new UserDeniedError()

    // get origin info
    var createdBy = await getCreatedBy(this.sender)

    // create the archive
    return dat.createNewArchive({title, description, createdBy})
  },

  async forkArchive(url, {title, description} = {}) {
    // ask the user
    // TODO should be fork-specific
    var decision = await requestPermission('createDat', this.sender, {title})
    if (decision === false) throw new UserDeniedError()

    // get origin info
    var createdBy = await getCreatedBy(this.sender)

    // create the archive
    return dat.forkArchive(url, {title, description, createdBy})
  },

  // TODO move into the library
  // deleteArchive: m(function * (url) {
  //   var { archive } = lookupArchive(url)
  //   var archiveKey = archive.key.toString('hex')

  //   // get the archive meta
  //   var details = await dat.getArchiveDetails(archiveKey)
  //   var oldSettings = details.userSettings

  //   // fail if this site isnt saved
  //   if (!details.userSettings.isSaved) {
  //     throw new ArchiveNotSavedError()
  //   }

  //   // ask the user
  //   var decision = await requestPermission('deleteDat:' + archiveKey, this.sender, { title: details.title })
  //   if (decision === false) throw new UserDeniedError()

  //   // delete
  //   await archivesDb.setArchiveUserSettings(archive.key, {isSaved: false})
  // },

  async stat(url, opts = {}) {
    // TODO versions
    var { archive, filepath } = lookupArchive(url)
    var downloadedBlocks = opts.downloadedBlocks === true
    var entry = await pda.lookupEntry(archive, filepath, opts)
    if (!entry) {
      throw new FileNotFoundError()
    }
    if (downloadedBlocks) {
      entry.downloadedBlocks = archive.countDownloadedBlocks(entry)
    }
    return entry
  },

  async readFile(url, opts = {}) {
    // TODO versions
    var { archive, filepath } = lookupArchive(url)
    return pda.readFile(archive, filepath, opts)
  },

  async writeFile(url, data, opts = {}) {
    var { archive, filepath } = lookupArchive(url)
    var senderOrigin = archivesDb.extractOrigin(this.sender.getURL())
    await assertWritePermission(archive, this.sender)
    await assertQuotaPermission(archive, senderOrigin, Buffer.byteLength(data, opts.encoding))
    await assertValidFilePath(filepath)
    if (isProtectedFilePath(filepath)) {
      throw new ProtectedFileNotWritableError()
    }
    return pda.writeFile(archive, filepath, data, opts)
  },

  async deleteFile(url) {
    // var { archive, filepath } = lookupArchive(url)
    throw new Error('not yet implemented') // TODO
  },

  async readDirectory(url, opts = {}) {
    // TODO history
    var { archive, filepath } = lookupArchive(url)
    return pda.listFiles(archive, filepath, opts)
  },

  async createDirectory(url) {
    var { archive, filepath } = lookupArchive(url)
    await assertWritePermission(archive, this.sender)
    await assertValidPath(filepath)
    if (isProtectedFilePath(filepath)) {
      throw new ProtectedFileNotWritableError()
    }
    return pda.createDirectory(archive, filepath)
  },

  async deleteDirectory(url) {
    // var { archive, filepath } = lookupArchive(url)
    throw new Error('not yet implemented') // TODO
  }
}

// internal helpers
// =

// helper to check if filepath refers to a file that userland is not allowed to edit directly
function isProtectedFilePath (filepath) {
  return filepath === '/dat.json'
}

async function assertWritePermission (archive, sender) {
  var archiveKey = archive.key.toString('hex')
  const perm = ('modifyDat:' + archiveKey)

  // ensure we have the archive's private key
  if (!archive.owner) throw new ArchiveNotWritableError()

  // ensure the sender is allowed to write
  var allowed = await queryPermission(perm, sender)
  if (allowed) return true

  // ask the user
  var details = await dat.getArchiveDetails(archiveKey)
  allowed = await requestPermission(perm, sender, { title: details.title })
  if (!allowed) throw new UserDeniedError()
  return true
}

async function assertQuotaPermission (archive, senderOrigin, byteLength) {
  // fetch the archive meta, and the current quota for the site
  const [meta, userSettings] = await Promise.all([
    archivesDb.getArchiveMeta(archive.key),
    archivesDb.getArchiveUserSettings(archive.key)
  ])

  // fallback to default quota
  var bytesAllowed = userSettings.bytesAllowed || DAT_QUOTA_DEFAULT_BYTES_ALLOWED

  // check the new size
  var newSize = meta.size + byteLength
  if (newSize > bytesAllowed) {
    throw new QuotaExceededError()
  }
}

async function assertValidFilePath (filepath) {
  if (filepath.slice(-1) === '/') {
    throw new InvalidPathError('Files can not have a trailing slash')
  }
  await assertValidPath (filepath)
}

async function assertValidPath (fileOrFolderPath) {
  if (!DAT_VALID_PATH_REGEX.test(fileOrFolderPath)) {
    throw new InvalidPathError('Path contains invalid characters')
  }
}

// helper to handle the URL argument that's given to most args
// - can get a dat hash, or dat url
// - returns { archive, filepath }
// - throws if the filepath is invalid
function lookupArchive (url) {
  var archiveKey, filepath
  if (DAT_HASH_REGEX.test(url)) {
    // simple case: given the key
    archiveKey = url
    filepath = '/'
  } else {
    var urlp = parseURL(url)

    // validate
    if (urlp.protocol !== 'dat:') {
      throw new InvalidURLError('URL must be a dat: scheme')
    }
    if (!DAT_HASH_REGEX.test(urlp.host)) {
      // TODO- support dns lookup?
      throw new InvalidURLError('Hostname is not a valid hash')
    }

    archiveKey = urlp.host
    filepath = urlp.pathname
  }

  // multiple slashes at the start of the filepath is an easy mistake to make in URL construction
  // correct against it automatically
  filepath = filepath.replace(/^\/+/, '/')

  // lookup the archive
  var archive = dat.getArchive(archiveKey)
  if (!archive) archive = dat.loadArchive(new Buffer(archiveKey, 'hex'))
  return { archive, filepath }
}

async function getCreatedBy (sender) {
  // fetch some origin info
  var originTitle = null
  var origin = archivesDb.extractOrigin(sender.getURL())
  try {
    var originKey = /dat:\/\/([^\/]*)/.exec(origin)[1]
    var originMeta = await archivesDb.getArchiveMeta(originKey)
    originTitle = originMeta.title || null
  } catch (e) {}

  // construct info
  if (originTitle) {
    return {url: origin, title: originTitle}
  }
  return {url: origin}
}
