import test from 'ava'
import {Application} from 'spectron'
import os from 'os'
import path from 'path'
import fs from 'fs'
import electron from '../node_modules/electron'

import * as browserdriver from './lib/browser-driver'
import { shareDat } from './lib/dat-helpers'

const app = new Application({
  path: electron,
  args: ['../app'],
  chromeDriverLogPath: 'dat-web-api-test.log',
  env: { 
    beaker_user_data_path: fs.mkdtempSync(os.tmpdir() + path.sep + 'beaker-test-'),
    beaker_dat_quota_default_bytes_allowed: 1024 * 10 // 10kb
  }
})
var testStaticDat, testStaticDatURL
var testRunnerDat, testRunnerDatURL
var createdDatURL // url of the dat which is created by testRunnerDat, which gives it write access
var createdDatKey

test.before(async t => {
  // open the window
  await app.start()
  await app.client.waitUntilWindowLoaded()

  // share the test static dat
  testStaticDat = await shareDat(__dirname + '/scaffold/test-static-dat')
  testStaticDatURL = 'dat://' + testStaticDat.archive.key.toString('hex') + '/'

  // share the test runner dat
  testRunnerDat = await shareDat(__dirname + '/scaffold/test-runner-dat')
  testRunnerDatURL = 'dat://' + testRunnerDat.archive.key.toString('hex') + '/'

  // open the test-runner dat
  await browserdriver.navigateTo(app, testRunnerDatURL)
  await app.client.windowByIndex(1)
  await app.client.waitForExist('h1#loaded')
})
test.after.always('cleanup', async t => {
  console.log(await app.client.getMainProcessLogs())
  await app.stop()
})

// some custom wrappers around async calls
// (the remove execution can be a little janky, these wrappers solve that)
async function stat (url, path, opts) {
  var res = await app.client.executeAsync((url, path, opts, done) => {
    var archive = new DatArchive(url)
    archive.stat(path, opts).then(v => done(stringify(v)), done)
  }, url, path, opts)
  if (typeof res.value === 'string')
    res.value = JSON.parse(res.value)
  return res
}

// tests
//

test('archive.listFiles', async t => {
  async function listFiles (url, path, opts) {
    return app.client.executeAsync((url, path, opts, done) => {
      var archive = new DatArchive(url)
      archive.listFiles(path, opts).then(done, done)
    }, url, path, opts || null)
  }

  // root dir
  let listing1 = await listFiles(testStaticDatURL, '/')
  t.deepEqual(Object.keys(listing1.value).sort(), ['beaker.png', 'hello.txt', 'subdir'])

  // subdir
  let listing2 = await listFiles(testStaticDatURL, '/subdir')
  t.deepEqual(Object.keys(listing2.value).sort(), ['hello.txt'])
})

test('archive.readFile', async t => {
  async function readFile (url, path, opts) {
    return app.client.executeAsync((url, path, opts, done) => {
      var archive = new DatArchive(url)
      archive.readFile(path, opts).then(done, done)
    }, url, path, opts)
  }

  var beakerPng = fs.readFileSync(__dirname + '/scaffold/test-static-dat/beaker.png')

  // read utf8
  var helloTxt = await readFile(testStaticDatURL, 'hello.txt', {})
  t.deepEqual(helloTxt.value, 'hello')

  // read utf8 2
  var helloTxt2 = await readFile(testStaticDatURL, '/subdir/hello.txt', 'utf8')
  t.deepEqual(helloTxt2.value, 'hi')

  // read hex
  var beakerPngHex = await readFile(testStaticDatURL, 'beaker.png', 'hex')
  t.deepEqual(beakerPngHex.value, beakerPng.toString('hex'))

  // read base64
  var beakerPngBase64 = await readFile(testStaticDatURL, 'beaker.png', 'base64')
  t.deepEqual(beakerPngBase64.value, beakerPng.toString('base64'))

  // read binary
  var beakerPngBinary = await readFile(testStaticDatURL, 'beaker.png', 'binary')
  t.truthy(beakerPng.equals(Buffer.from(beakerPngBinary.value)))

  // timeout: read an archive that does not exist
  var fakeUrl = 'dat://' + ('f'.repeat(64)) + '/'
  var entry = await readFile(fakeUrl, 'hello.txt', { timeout: 500 })
  t.deepEqual(entry.value.name, 'TimeoutError')
})

test('archive.stat', async t => {
  // stat root file
  var entry = await stat(testStaticDatURL, 'hello.txt', {})
  t.deepEqual(entry.value.name, 'hello.txt', 'root file')
  t.deepEqual(entry.value.type, 'file', 'root file')

  // include downloadedBlocks
  var entry = await stat(testStaticDatURL, 'hello.txt', { downloadedBlocks: true })
  t.deepEqual(entry.value.name, 'hello.txt', 'downloadedBlocks')
  t.deepEqual(entry.value.type, 'file', 'downloadedBlocks')
  t.deepEqual(entry.value.downloadedBlocks, entry.value.blocks)

  // stat subdir file
  var entry = await stat(testStaticDatURL, 'subdir/hello.txt', {})
  t.deepEqual(entry.value.name, 'subdir/hello.txt', 'subdir file')
  t.deepEqual(entry.value.type, 'file', 'subdir file')

  // stat subdir
  var entry = await stat(testStaticDatURL, 'subdir', {})
  t.deepEqual(entry.value.name, 'subdir', 'subdir')
  t.deepEqual(entry.value.type, 'directory', 'subdir')

  // stat non-existent file
  var entry = await stat(testStaticDatURL, 'notfound', {})
  t.deepEqual(entry.value.name, 'FileNotFoundError')

  // stat alt-formed path
  var entry = await stat(testStaticDatURL, '/hello.txt', {})
  t.deepEqual(entry.value.name, 'hello.txt', 'alt-formed path')
  t.deepEqual(entry.value.type, 'file', 'alt-formed path')

  // timeout: stat an archive that does not exist
  var fakeUrl = 'dat://' + ('f'.repeat(64)) + '/'
  var entry = await stat(fakeUrl, 'hello.txt', { timeout: 500 })
  t.deepEqual(entry.value.name, 'TimeoutError')
})

test('DatArchive.create rejection', async t => {
  // start the prompt
  await app.client.execute(() => {
    // put the result on the window, for checking later
    window.res = null
    DatArchive.create({ title: 'The Title', description: 'The Description' }).then(
      res => window.res = res,
      err => window.res = err
    )
  })

  // reject the prompt
  await app.client.windowByIndex(0)
  await app.client.click('.prompt-reject')
  await app.client.windowByIndex(1)

  // fetch & test the res
  await app.client.waitUntil(() => app.client.execute(() => { return window.res != null }))
  var res = await app.client.execute(() => { return window.res })
  t.deepEqual(res.value.name, 'UserDeniedError')
})

test('DatArchive.create', async t => {
  // start the prompt
  await app.client.execute(() => {
    // put the result on the window, for checking later
    window.res = null
    DatArchive.create({ title: 'The Title', description: 'The Description' }).then(
      res => window.res = res,
      err => window.res = err
    )
  })

  // accept the prompt
  await app.client.windowByIndex(0)
  await app.client.click('.prompt-accept')
  await app.client.windowByIndex(1)

  // fetch & test the res
  await app.client.pause(500)
  await app.client.waitUntil(() => app.client.execute(() => { return window.res != null }))
  var res = await app.client.execute(() => { return window.res })
  createdDatURL = res.value.url
  t.truthy(createdDatURL.startsWith('dat://'))
  createdDatKey = createdDatURL.slice('dat://'.length)

  // check the dat.json
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.readFile('dat.json').then(done, done)
  }, createdDatURL)
  var manifest
  try {
    var manifest = JSON.parse(res.value)
  } catch (e) {
    console.log('unexpected error parsing manifest', res.value)
  }
  t.deepEqual(manifest.title, 'The Title')
  t.deepEqual(manifest.description, 'The Description')
  t.deepEqual(manifest.createdBy.url, testRunnerDatURL.slice(0, -1))
  t.deepEqual(manifest.createdBy.title, 'Test Runner Dat')

  // check the settings
  await app.client.windowByIndex(0)
  var details = await app.client.executeAsync((key, done) => {
    datInternalAPI.getArchiveInfo(key).then(done, err => done({ err }))
  }, createdDatKey)
  await app.client.windowByIndex(1)
  t.deepEqual(details.value.userSettings.isSaved, true)
})

test('archive.writeFile', async t => {
  async function dotest (filename, content, encoding) {
    // write to the top-level
    var res = await app.client.executeAsync((url, filename, content, encoding, done) => {
      if (content.data) content = new Uint8Array(content.data) // spectron fucks up our data, unfuck it
      var archive = new DatArchive(url)
      archive.writeFile(filename, content, encoding).then(done, done)
    }, createdDatURL, filename, content, encoding)
    t.falsy(res.value)

    // read it back
    var res = await app.client.executeAsync((url, filename, opts, done) => {
      var archive = new DatArchive(url)
      archive.readFile(filename, opts).then(done, done)
    }, createdDatURL, filename, encoding)
    if (encoding === 'binary') {
      t.truthy(content.equals(Buffer.from(res.value)))
    } else {
      t.deepEqual(res.value, content)
    }
  }

  var beakerPng = fs.readFileSync(__dirname + '/scaffold/test-static-dat/beaker.png')
  await dotest('hello.txt', 'hello world', 'utf8')
  await dotest('beaker1.png', beakerPng, 'binary')
  await dotest('beaker2.png', beakerPng.toString('base64'), 'base64')
  await dotest('beaker3.png', beakerPng.toString('hex'), 'hex')
})

test('archive.writeFile does not write to nonexistent directories', async t => {
  // write to a subdir
  var res = await app.client.executeAsync((url, filename, done) => {
    var archive = new DatArchive(url)
    archive.writeFile(filename, 'hello world', 'utf8').then(done, done)
  }, createdDatURL, 'subdir/hello.txt')
  t.deepEqual(res.value.name, 'ParentFolderDoesntExistError')
})

test('archive.writeFile gives an error for malformed names', async t => {
  // write to the root dir
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.writeFile('/', 'hello world', 'utf8').then(done, done)
  }, createdDatURL)
  t.deepEqual(res.value.name, 'InvalidPathError')

  // write to a subdir
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.writeFile('/subdir/hello.txt/', 'hello world', 'utf8').then(done, done)
  }, createdDatURL)
  t.deepEqual(res.value.name, 'InvalidPathError')

  // write with a bad char
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.writeFile('hello`.txt', 'hello world', 'utf8').then(done, done)
  }, createdDatURL)
  t.deepEqual(res.value.name, 'InvalidPathError')
})

test('archive.writeFile protects the manifest', async t => {
  // write to the manifest
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.writeFile('dat.json', 'hello world', 'utf8').then(done, done)
  }, createdDatURL)
  t.deepEqual(res.value.name, 'ProtectedFileNotWritableError')
})

test('archive.createDirectory', async t => {
  // create the directory
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.createDirectory('subdir').then(done, done)
  }, createdDatURL)
  t.falsy(res.value)

  // read it back
  var res = await stat(createdDatURL, 'subdir', {})
  t.deepEqual(res.value.name, '/subdir')
  t.deepEqual(res.value.type, 'directory')
})

test('archive.writeFile writes to subdirectories', async t => {
  // write to a subdir
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.writeFile('subdir/hello.txt', 'hello world', 'utf8').then(done, done)
  }, createdDatURL)
  t.falsy(res.value)

  // read it back
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.readFile('subdir/hello.txt', 'utf8').then(done, done)
  }, createdDatURL)
  t.deepEqual(res.value, 'hello world')
})

test('archive.writeFile doesnt overwrite folders', async t => {
  // write to the subdir
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.writeFile('/subdir', 'hello world', 'utf8').then(done, done)
  }, createdDatURL)
  t.deepEqual(res.value.name, 'EntryAlreadyExistsError')
})

test('archive.createDirectory doesnt overwrite files or folders', async t => {
  // write to the subdir
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.createDirectory('/').then(done, done)
  }, createdDatURL)
  t.deepEqual(res.value.name, 'EntryAlreadyExistsError')

  // write to the subdir
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.createDirectory('/subdir').then(done, done)
  }, createdDatURL)
  t.deepEqual(res.value.name, 'EntryAlreadyExistsError')

  // write to the file
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.createDirectory('/hello.txt').then(done, done)
  }, createdDatURL)
  t.deepEqual(res.value.name, 'EntryAlreadyExistsError')
})

test('archive.createDirectory gives an error for malformed names', async t => {
  // write with a bad char
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.createDirectory('hello`world').then(done, done)
  }, createdDatURL)
  t.deepEqual(res.value.name, 'InvalidPathError')
})

test('archive.writeFile doesnt allow writes that exceed the quota', async t => {
  // write to the subdir
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.writeFile('/denythis.txt', 'x'.repeat(1024 * 12), 'utf8').then(done, done)
  }, createdDatURL)
  t.deepEqual(res.value.name, 'QuotaExceededError')
})

test('archive.writeFile and archive.createDirectory fail to write to unowned archives', async t => {
  // writeFile
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.writeFile('/denythis.txt', 'hello world', 'utf8').then(done, done)
  }, testStaticDatURL)
  t.deepEqual(res.value.name, 'ArchiveNotWritableError')

  // createDirectory
  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.createDirectory('/denythis').then(done, done)
  }, testStaticDatURL)
  t.deepEqual(res.value.name, 'ArchiveNotWritableError')
})

test('archive.writeFile & archive.createDirectory doesnt allow writes to archives until write permission is given', async t => {

  // create the target dat internally, so that it's writable but not owned by the test runner dat
  // =

  await app.client.windowByIndex(0)
  var res = await app.client.executeAsync((done) => {
    datInternalAPI.createNewArchive({ title: 'Another Test Dat' }).then(done, done)
  })
  t.falsy(res.value.name, 'create didnt fail')
  var newTestDatURL = res.value
  await app.client.windowByIndex(1)

  // writefile deny
  //

  // start the prompt
  await app.client.execute(url => {
    // put the result on the window, for checking later
    window.res = null
    var archive = new DatArchive(url)
    archive.writeFile('/denythis.txt', 'hello world', 'utf8').then(
      res => window.res = res,
      err => window.res = err
    )
  }, newTestDatURL)

  // accept the prompt
  await app.client.windowByIndex(0)
  await app.client.click('.prompt-reject')
  await app.client.windowByIndex(1)

  // fetch & test the res
  var res = await app.client.execute(() => { return window.res })
  t.deepEqual(res.value.name, 'UserDeniedError', 'write file denied')

  // createDirectory deny
  //

  // start the prompt
  await app.client.execute(url => {
    // put the result on the window, for checking later
    window.res = null
    var archive = new DatArchive(url)
    archive.createDirectory('/denythis').then(
      res => window.res = res,
      err => window.res = err
    )
  }, newTestDatURL)

  // accept the prompt
  await app.client.windowByIndex(0)
  await app.client.click('.prompt-reject')
  await app.client.windowByIndex(1)

  // fetch & test the res
  var res = await app.client.execute(() => { return window.res })
  t.deepEqual(res.value.name, 'UserDeniedError', 'create directory denied')

  // writeFile accept
  // =

  // start the prompt
  await app.client.execute(url => {
    // put the result on the window, for checking later
    window.res = null
    var archive = new DatArchive(url)
    archive.writeFile('/allowthis.txt', 'hello world', 'utf8').then(
      res => window.res = res,
      err => window.res = err
    )
  }, newTestDatURL)

  // accept the prompt
  await app.client.windowByIndex(0)
  await app.client.click('.prompt-accept')
  await app.client.windowByIndex(1)

  // fetch & test the res
  var res = await app.client.execute(() => { return window.res })
  t.falsy(res.value, 'write file accepted')

  // writeFile accept persisted perm
  // =

  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.writeFile('allowthis2.txt', 'hello world', 'utf8').then(done, done)
  }, newTestDatURL)
  t.falsy(res.value, 'write file 2 accepted')

  // createDirectory accept persisted perm
  // =

  var res = await app.client.executeAsync((url, done) => {
    var archive = new DatArchive(url)
    archive.createDirectory('allowthis').then(done, done)
  }, newTestDatURL)
  t.falsy(res.value, 'createdirectory accepted')
})
