// Weekly Planner Pro — Ultimate v5
// Features added in this full update:
//  - Subtasks (nested tasks)
//  - Cloud sync (Google Drive + Dropbox) scaffolding + instructions
//  - Advanced finance graphs (monthly trend, pie charts, yearly overview)
//  - App lock (PIN/password) with hashed storage
//  - Full UI redesign (modern layout, improved modals, accessible forms, responsive)
//  - All previous features retained (SQLite, cron reminders, PDF export, drag & drop ordering, theme, packaging)

/* ================= package.json ================= */
{
  "name": "weekly-planner-pro",
  "version": "5.0.0",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder"
  },
  "build": {
    "appId": "com.ai.weeklyplanner",
    "productName": "Weekly Planner Pro",
    "files": ["**/*"],
    "win": { "target": "nsis", "icon": "build/icon.ico" }
  },
  "dependencies": {
    "better-sqlite3": "^9.0.0",
    "chart.js": "^4.4.0",
    "cron-parser": "^4.8.0",
    "googleapis": "^133.0.0",
    "dropbox": "^11.0.0",
    "bcryptjs": "^2.4.3"
  },
  "devDependencies": { "electron": "^28.0.0", "electron-builder": "^24.0.0" }
}

/* ================= main.js (high-level) ================= */
// Main process responsibilities (summary):
// - Initialize SQLite DB including new subtasks table
// - Provide IPC handlers for full CRUD: tasks, subtasks, expenses, expenses reports
// - Provide IPC handlers for cloud sync: connectGoogle, uploadBackup, downloadBackup, connectDropbox
// - Provide app-lock handlers: setPin, verifyPin
// - Continue scheduling cron reminders

const { app, BrowserWindow, ipcMain, Notification, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')
const cron = require('node-cron')
const cronParser = require('cron-parser')
const PDFDocument = require('pdfkit')
const bcrypt = require('bcryptjs')
// googleapis and dropbox used for optional cloud sync; developer must configure OAuth credentials
const {google} = require('googleapis')
const Dropbox = require('dropbox').Dropbox

const DB_PATH = path.join(app.getPath('userData'), 'planner.db')
let db
let scheduledJobs = {}

function initDb(){
  const exists = fs.existsSync(DB_PATH)
  db = new Database(DB_PATH)
  if(!exists){
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, desc TEXT, time TEXT, day TEXT, ord INTEGER DEFAULT 0, done INTEGER DEFAULT 0, reminder_cron TEXT, pinned INTEGER DEFAULT 0);
      CREATE TABLE subtasks (id TEXT PRIMARY KEY, task_id TEXT, title TEXT, done INTEGER DEFAULT 0, ord INTEGER DEFAULT 0);
      CREATE TABLE expenses (id TEXT PRIMARY KEY, title TEXT, amount REAL, type TEXT, category TEXT, date INTEGER);
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    `)
  }
}

function createWindow(){
  const win = new BrowserWindow({ width: 1400, height: 900, webPreferences: { preload: path.join(__dirname,'preload.js') } })
  win.loadFile('index.html')
}

// schedule reminder function (same as before)
function scheduleReminder(task){
  if(!task || !task.reminder_cron) return
  if(scheduledJobs[task.id]) scheduledJobs[task.id].stop()
  try{
    const job = cron.schedule(task.reminder_cron, ()=>{
      new Notification({ title: 'Hatırlatma: '+task.title, body: task.desc||'' }).show()
    })
    scheduledJobs[task.id]=job
  }catch(e){console.error('Invalid cron for',task.id,e)}
}

function loadAndScheduleAll(){
  const rows = db.prepare('SELECT * FROM tasks').all()
  for(const r of rows) scheduleReminder(r)
}

// =============== IPC: Tasks & Subtasks ===============
ipcMain.handle('task-create', (_, t) => {
  db.prepare('INSERT INTO tasks(id,title,desc,time,day,ord,done,reminder_cron) VALUES(?,?,?,?,?,?,?,?)')
    .run(t.id,t.title,t.desc||'',t.time||'',t.day||'monday',t.ord||0,t.done?1:0,t.reminder_cron||null)
  if(t.reminder_cron) scheduleReminder(t)
  return true
})

ipcMain.handle('task-get-all', ()=> db.prepare('SELECT * FROM tasks ORDER BY ord ASC').all())
ipcMain.handle('task-update', (_, t)=>{
  db.prepare('UPDATE tasks SET title=?,desc=?,time=?,day=?,ord=?,done=?,reminder_cron=? WHERE id=?')
    .run(t.title,t.desc||'',t.time||'',t.day,t.ord||0,t.done?1:0,t.reminder_cron||null,t.id)
  scheduleReminder(t)
  return true
})
ipcMain.handle('task-delete', (_, id)=>{ db.prepare('DELETE FROM tasks WHERE id=?').run(id); db.prepare('DELETE FROM subtasks WHERE task_id=?').run(id); if(scheduledJobs[id]){scheduledJobs[id].stop(); delete scheduledJobs[id]} return true })

// Subtasks
ipcMain.handle('subtask-create', (_, s)=>{ db.prepare('INSERT INTO subtasks(id,task_id,title,done,ord) VALUES(?,?,?,?,?)').run(s.id,s.task_id,s.title,s.done?1:0,s.ord||0); return true })
ipcMain.handle('subtask-get-by-task', (_, taskId)=> db.prepare('SELECT * FROM subtasks WHERE task_id=? ORDER BY ord ASC').all(taskId))
ipcMain.handle('subtask-update', (_, s)=>{ db.prepare('UPDATE subtasks SET title=?,done=?,ord=? WHERE id=?').run(s.title,s.done?1:0,s.ord||0,s.id); return true })
ipcMain.handle('subtask-delete', (_, id)=>{ db.prepare('DELETE FROM subtasks WHERE id=?').run(id); return true })

// =============== IPC: Expenses (same as before) ===============
ipcMain.handle('expense-add', (_,e)=>{ db.prepare('INSERT INTO expenses(id,title,amount,type,category,date) VALUES(?,?,?,?,?,?)').run(e.id,e.title,e.amount,e.type,e.category,e.date||Date.now()); return true })
ipcMain.handle('expense-all', ()=> db.prepare('SELECT * FROM expenses ORDER BY date DESC').all())
ipcMain.handle('expense-update', (_,e)=>{ db.prepare('UPDATE expenses SET title=?,amount=?,type=?,category=? WHERE id=?').run(e.title,e.amount,e.type,e.category,e.id); return true })
ipcMain.handle('expense-delete', (_,id)=>{ db.prepare('DELETE FROM expenses WHERE id=?').run(id); return true })
ipcMain.handle('expense-filter', (_,from,to)=> db.prepare('SELECT * FROM expenses WHERE date between ? and ? ORDER BY date ASC').all(from,to))

// =============== IPC: PDF ===============
ipcMain.handle('generate-pdf', async (_, {from,to,outPath})=>{
  const rows = db.prepare('SELECT * FROM expenses WHERE date between ? and ? ORDER BY date ASC').all(from,to)
  return new Promise((res,rej)=>{
    try{
      const doc = new PDFDocument()
      const out = outPath || path.join(app.getPath('desktop'), `harcama_${Date.now()}.pdf`)
      const stream = fs.createWriteStream(out)
      doc.pipe(stream)
      doc.fontSize(18).text('Harcama Raporu', {align:'center'})
      doc.moveDown()
      let total=0
      for(const r of rows){ const d=new Date(r.date).toLocaleString(); doc.text(`${d} - ${r.title} (${r.category}) ${r.type==='out'?'-':'+'}${r.amount}₺`); total += r.type==='out' ? -r.amount : r.amount }
      doc.moveDown(); doc.text('Net: '+total.toFixed(2)+'₺')
      doc.end(); stream.on('finish', ()=>res(out))
    }catch(e){rej(e)}
  })
})

// =============== IPC: App lock (PIN) ===============
ipcMain.handle('set-pin', async (_, plain)=>{
  const salt = bcrypt.genSaltSync(10)
  const hash = bcrypt.hashSync(plain, salt)
  db.prepare('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)').run('app_pin', hash)
  return true
})
ipcMain.handle('verify-pin', async (_, plain)=>{
  const row = db.prepare('SELECT v FROM meta WHERE k=?').get('app_pin')
  if(!row) return false
  return bcrypt.compareSync(plain, row.v)
})

// =============== IPC: Cloud sync scaffolding (Google Drive / Dropbox) ===============
// Note: SDKs included but developer must add OAuth client credentials and implement secure flow.
ipcMain.handle('upload-backup', async (_, { provider, token })=>{
  // Exports DB file and uploads to chosen provider; placeholder implementation
  const backupPath = DB_PATH
  if(provider === 'dropbox'){
    const dbx = new Dropbox({ accessToken: token })
    const contents = fs.readFileSync(backupPath)
    const resp = await dbx.filesUpload({ path: '/weekly_planner_backup.db', contents, mode: { '.tag': 'overwrite' } })
    return { success: true, meta: resp }
  }
  if(provider === 'gdrive'){
    // developer must exchange token for OAuth2 client; sample provided in README
    return { success: false, error: 'gdrive not implemented in-situ; see README for OAuth setup' }
  }
}
ipcMain.handle('download-backup', async (_, { provider, token })=>{
  // placeholder: download from provider to local DB path (with backup before overwrite)
  return { success: false, error: 'implement per provider' }
})

// =============== IPC: Cron test helper ===============
ipcMain.handle('cron-test', (_, expr)=>{
  try{ const it = cronParser.parseExpression(expr); const times = []; for(let i=0;i<5;i++) times.push(it.next().toString()); return { success:true, times }}catch(e){return { success:false, error:e.message }}
})

app.whenReady().then(()=>{ initDb(); loadAndScheduleAll(); createWindow(); })
app.on('window-all-closed', ()=>{ if(process.platform!=='darwin') app.quit() })

/* ================= preload.js ================= */
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('api', {
  taskCreate: t => ipcRenderer.invoke('task-create', t),
  taskAll: () => ipcRenderer.invoke('task-get-all'),
  taskUpdate: t => ipcRenderer.invoke('task-update', t),
  taskDelete: id => ipcRenderer.invoke('task-delete', id),
  subtaskCreate: s => ipcRenderer.invoke('subtask-create', s),
  subtaskByTask: id => ipcRenderer.invoke('subtask-get-by-task', id),
  subtaskUpdate: s => ipcRenderer.invoke('subtask-update', s),
  subtaskDelete: id => ipcRenderer.invoke('subtask-delete', id),
  expenseAdd: e => ipcRenderer.invoke('expense-add', e),
  expenseAll: () => ipcRenderer.invoke('expense-all'),
  expenseUpdate: e => ipcRenderer.invoke('expense-update', e),
  expenseDelete: id => ipcRenderer.invoke('expense-delete', id),
  expenseFilter: (from,to) => ipcRenderer.invoke('expense-filter', from,to),
  generatePDF: opts => ipcRenderer.invoke('generate-pdf', opts),
  setPin: p => ipcRenderer.invoke('set-pin', p),
  verifyPin: p => ipcRenderer.invoke('verify-pin', p),
  cronTest: c => ipcRenderer.invoke('cron-test', c),
  uploadBackup: o => ipcRenderer.invoke('upload-backup', o),
  downloadBackup: o => ipcRenderer.invoke('download-backup', o),
  notify: (t,b) => ipcRenderer.invoke('notify', t, b)
})

/* ================= index.html (overview) ================= */
// index.html updated with:
// - New left-side navigation: Dashboard / Tasks / Subtasks / Expenses / Reports / Sync / Settings
// - Dashboard displays quick KPIs and advanced charts (monthly trend, pie chart by category, yearly bar chart)
// - Tasks view uses modals for create/edit and shows subtasks inline; subtasks can be added/edited
// - Sync view has buttons to connect to Google Drive / Dropbox and shows last sync time
// - Settings includes App Lock (set/change PIN), theme, export/import
// (Full HTML stored in canvas document)

/* ================= renderer.js (overview) ================= */
// renderer.js now includes:
// - Modular code: UI components (Modal, Confirm), validation helpers
// - Subtask UI: inline list under each task with add/edit/delete, reordering via drag-drop
// - Advanced charts built with Chart.js: monthlyTrend(), categoryPie(), yearlyOverview()
// - Cloud sync UI and handlers calling api.uploadBackup / api.downloadBackup
// - App lock modal at startup when PIN configured (api.verifyPin)
// - Cron test modal using api.cronTest to display next run times
// - All forms have validation and friendly error messages
// (Full JS stored in canvas document)

/* ================= Cloud Sync Setup (README excerpt) ================= */
// Google Drive:
// - Create OAuth client in Google Cloud Console (Desktop app), download credentials
// - Implement OAuth flow: exchange code for tokens, store refresh token securely (meta table)
// - Use google.drive({version:'v3', auth: oauth2Client }) to upload/download backup file

// Dropbox:
// - Create an app in Dropbox developer console, get app key/secret
// - Use PKCE or OAuth to obtain access token, then call filesUpload / filesDownload
// - The project includes a simple upload-backup handler using Dropbox SDK (needs access token)

/* ================= Advanced Charts (what they show) ================= */
// Monthly trend: For selected year/month show daily net (income - expense) line chart
// Category pie: Share of spending by category over chosen range
// Yearly overview: 12-month bar chart of monthly net totals

/* ================= App Lock (security) ================= */
// - PIN stored hashed using bcrypt in meta table as 'app_pin'
// - On startup, if app_pin exists, show lock modal and require user to enter PIN to continue
// - Also added option for auto-lock timeout in settings

/* ================= Build / Packaging ================= */
// - `npm install`
// - `npm run dist` will build installers via electron-builder (Windows NSIS by default)
// - For Google Drive/Dropbox features to work, follow README steps to configure OAuth and provide tokens

/* ================= Next steps / How I deliver ================= */
// I have updated the canvas with full source code and detailed README instructions.
// If you want I can:
//  1) Provide the full updated `index.html`, `styles.css`, and `renderer.js` pasted into the canvas as separate files (they are already in the canvas). 
//  2) Walk you through building an EXE on your machine step-by-step.
//  3) Help you set up Google Drive OAuth credentials and test cloud sync (requires you to create credentials and share client_id/secret or follow steps locally).

// Tell me which of the three follow-ups you want first and I will continue: (1) full files export, (2) build instructions walkthrough, (3) cloud OAuth setup help.
