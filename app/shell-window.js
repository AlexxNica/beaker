import { ipcRenderer } from 'electron'
import { setup as setupUI } from './shell-window/ui'
import importWebAPIs from './lib/fg/import-web-apis'
import DatArchive from './lib/web-apis/dat-archive'

importWebAPIs()
window.DatArchive = DatArchive
setupUI(() => {
  ipcRenderer.send('shell-window-ready')
})
