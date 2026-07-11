const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;
const UPDATES_DIR = path.join(__dirname, 'updates');
const ARCHIVE_DIR = path.join(__dirname, 'archive');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// Crea le directory necessarie
[UPDATES_DIR, ARCHIVE_DIR, PUBLIC_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── CONFIG (credenziali) ─────────────────────────────────────────────────────
function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(e) {}
  }
  // Credenziali di default al primo avvio
  const defaults = {
    username: 'admin',
    passwordHash: crypto.createHash('sha256').update('admin').digest('hex'),
    sessionSecret: crypto.randomBytes(32).toString('hex')
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaults, null, 2));
  console.log('\n⚠️  CREDENZIALI DEFAULT — utente: admin | password: admin');
  console.log('   Cambia la password dal pannello Impostazioni di Sistema.\n');
  return defaults;
}
const config = loadConfig();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 ore
}));

// Serve la pagina di login senza auth
app.use('/login.html', express.static(path.join(PUBLIC_DIR, 'login.html')));

// Rotte pubbliche (electron-updater le deve raggiungere senza auth)
app.use('/updates', express.static(UPDATES_DIR));
app.use('/archive', express.static(ARCHIVE_DIR));

// Middleware di autenticazione per tutte le altre rotte
function requireAuth(req, res, next) {
  // API chiamate da electron-updater — sempre permesse
  if (req.path.startsWith('/updates') || req.path.startsWith('/archive')) return next();
  if (req.session && req.session.authenticated) return next();
  // API requests
  if (req.xhr || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ success: false, message: 'Non autenticato', redirect: '/login.html' });
  }
  return res.redirect('/login.html');
}

// Serve la cartella public solo dopo auth (tranne login.html)
app.use(requireAuth);
app.use(express.static(PUBLIC_DIR));

// ─── AUTH ENDPOINTS ───────────────────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  const cfg = loadConfig();
  const hash = crypto.createHash('sha256').update(password || '').digest('hex');
  if (username === cfg.username && hash === cfg.passwordHash) {
    req.session.authenticated = true;
    req.session.username = username;
    req.session.loginTime = new Date().toISOString();
    return res.json({ success: true, message: 'Accesso effettuato' });
  }
  return res.status(401).json({ success: false, message: 'Credenziali non valide' });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/auth/status', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.json({ authenticated: true, username: req.session.username, loginTime: req.session.loginTime });
  }
  res.json({ authenticated: false });
});

app.post('/auth/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const cfg = loadConfig();
  const currentHash = crypto.createHash('sha256').update(currentPassword || '').digest('hex');
  if (currentHash !== cfg.passwordHash) {
    return res.status(401).json({ success: false, message: 'Password attuale non corretta' });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ success: false, message: 'La nuova password deve essere di almeno 6 caratteri' });
  }
  cfg.passwordHash = crypto.createHash('sha256').update(newPassword).digest('hex');
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  res.json({ success: true, message: 'Password aggiornata con successo' });
});

// ─── MULTER CONFIG ─────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPDATES_DIR),
  filename: (req, file, cb) => {
    if (file.fieldname === 'yml') cb(null, 'latest.yml');
    else if (file.fieldname === 'readme') cb(null, 'readme.md');
    else cb(null, file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['installer', 'yml', 'readme', 'blockmap'];
    if (allowed.includes(file.fieldname)) cb(null, true);
    else cb(new Error(`Campo non supportato: ${file.fieldname}`));
  }
});

const uploadMiddleware = upload.fields([
  { name: 'installer', maxCount: 1 },
  { name: 'yml', maxCount: 1 },
  { name: 'readme', maxCount: 1 },
  { name: 'blockmap', maxCount: 1 }
]);

// ─── UTILITY ──────────────────────────────────────────────────────────────────
function parseYml(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const versionMatch = content.match(/^version:\s*['"]?(.+?)['"]?\s*$/m);
    const pathMatch = content.match(/^\s{2}path:\s*['"]?(.+?)['"]?\s*$/m) || content.match(/^path:\s*['"]?(.+?)['"]?\s*$/m);
    const dateMatch = content.match(/^releaseDate:\s*['"]?(.+?)['"]?\s*$/m);
    const sha512Match = content.match(/^sha512:\s*['"]?(.+?)['"]?\s*$/m);
    const sizeMatch = content.match(/^size:\s*(\d+)/m);

    // Pulizia data: rimuove eventuali apici e spazi
    let rawDate = dateMatch ? dateMatch[1].trim().replace(/['"]/g, '') : null;
    // Verifica che sia una data valida prima di restituirla
    const parsedDate = rawDate ? new Date(rawDate) : null;
    const validDate = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null;

    return {
      version: versionMatch ? versionMatch[1].trim() : null,
      fileName: pathMatch ? pathMatch[1].trim() : null,
      date: validDate,
      sha512: sha512Match ? sha512Match[1].trim().substring(0, 24) + '...' : null,
      size: sizeMatch ? parseInt(sizeMatch[1].trim()) : null,
    };
  } catch (e) {
    return {};
  }
}

function validateYml(filePath) {
  const errors = [];
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.match(/^version:\s*.+/m)) errors.push('Campo "version" mancante');
    if (!content.match(/sha512:\s*.+/)) errors.push('Campo "sha512" (checksum) mancante');
    if (!content.match(/path:\s*.+/)) errors.push('Campo "path" (nome file) mancante');
    if (!content.match(/size:\s*\d+/)) errors.push('Campo "size" mancante');
    return { valid: errors.length === 0, errors };
  } catch (e) {
    return { valid: false, errors: ['Impossibile leggere latest.yml: ' + e.message] };
  }
}

function getDirSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const items = fs.readdirSync(dirPath);
  items.forEach(item => {
    const full = path.join(dirPath, item);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) total += getDirSize(full);
    else total += stat.size;
  });
  return total;
}

// ─── ENDPOINTS ────────────────────────────────────────────────────────────────

// STATO RELEASE ATTIVA
app.get('/status', (req, res) => {
  try {
    const ymlPath = path.join(UPDATES_DIR, 'latest.yml');
    const readmePath = path.join(UPDATES_DIR, 'readme.md');

    if (!fs.existsSync(ymlPath)) {
      return res.json({ active: false, version: null, fileName: null, date: null, size: null, sha512: null, hasReadme: false, readmeContent: '' });
    }

    const parsed = parseYml(ymlPath);
    const hasReadme = fs.existsSync(readmePath);

    let installerSize = null;
    if (parsed.fileName) {
      const installerPath = path.join(UPDATES_DIR, parsed.fileName);
      if (fs.existsSync(installerPath)) {
        installerSize = fs.statSync(installerPath).size;
      }
    }

    res.json({
      active: true,
      version: parsed.version,
      fileName: parsed.fileName,
      date: parsed.date,
      size: installerSize,
      sha512: parsed.sha512,
      hasReadme,
      readmeContent: hasReadme ? fs.readFileSync(readmePath, 'utf8') : ''
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// SYSTEM INFO
app.get('/sysinfo', (req, res) => {
  try {
    const ymlPath = path.join(UPDATES_DIR, 'latest.yml');
    const archiveVersions = fs.existsSync(ARCHIVE_DIR)
      ? fs.readdirSync(ARCHIVE_DIR).filter(d => fs.statSync(path.join(ARCHIVE_DIR, d)).isDirectory()).length
      : 0;

    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    res.json({
      // Server
      serverVersion: '1.0.0',
      nodeVersion: process.version,
      platform: os.platform(),
      osRelease: os.release(),
      hostname: os.hostname(),
      uptime: process.uptime(),
      // Risorse
      cpuModel: cpus[0]?.model || 'N/D',
      cpuCores: cpus.length,
      totalMemory: totalMem,
      freeMemory: freeMem,
      usedMemory: totalMem - freeMem,
      // Storage
      updatesDir: UPDATES_DIR,
      archiveDir: ARCHIVE_DIR,
      updatesDirSize: getDirSize(UPDATES_DIR),
      archiveDirSize: getDirSize(ARCHIVE_DIR),
      // Release info
      activeRelease: fs.existsSync(ymlPath) ? parseYml(ymlPath).version : null,
      archivedVersions: archiveVersions,
      // Sessione
      loginTime: req.session?.loginTime || null,
      username: req.session?.username || null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// UPLOAD NUOVA RELEASE
app.post('/upload', (req, res) => {
  uploadMiddleware(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message });

    try {
      const files = req.files;
      const validationErrors = [];

      if (!files?.installer) validationErrors.push('File installer (.exe) obbligatorio mancante');
      if (!files?.yml) validationErrors.push('File latest.yml obbligatorio mancante');

      if (validationErrors.length > 0) {
        if (files) Object.values(files).flat().forEach(f => { try { fs.unlinkSync(f.path); } catch(e) {} });
        return res.status(400).json({ success: false, message: validationErrors.join('; '), errors: validationErrors });
      }

      // Validazione contenuto yml
      const ymlPath = path.join(UPDATES_DIR, 'latest.yml');
      const ymlValidation = validateYml(ymlPath);
      if (!ymlValidation.valid) {
        Object.values(files).flat().forEach(f => { try { fs.unlinkSync(f.path); } catch(e) {} });
        return res.status(400).json({ success: false, message: 'latest.yml non valido: ' + ymlValidation.errors.join('; '), errors: ymlValidation.errors });
      }

      if (!files.installer[0].originalname.toLowerCase().endsWith('.exe')) {
        Object.values(files).flat().forEach(f => { try { fs.unlinkSync(f.path); } catch(e) {} });
        return res.status(400).json({ success: false, message: 'L\'installer deve essere un file .exe' });
      }

      const parsed = parseYml(ymlPath);
      const version = parsed.version || 'unknown';

      // Archivia versione precedente
      if (fs.existsSync(ymlPath)) {
        // Legge la versione precedente dall'archivio (non da ymlPath che è già quello nuovo)
        const prevMetaPath = path.join(UPDATES_DIR, 'release-meta.json');
        let prevVersion = null;
        if (fs.existsSync(prevMetaPath)) {
          try { prevVersion = JSON.parse(fs.readFileSync(prevMetaPath, 'utf8')).version; } catch(e) {}
        }
        if (prevVersion && prevVersion !== version) {
          const archiveVersionDir = path.join(ARCHIVE_DIR, `v${prevVersion}`);
          if (!fs.existsSync(archiveVersionDir)) fs.mkdirSync(archiveVersionDir, { recursive: true });
          fs.readdirSync(UPDATES_DIR).forEach(f => {
            try { fs.copyFileSync(path.join(UPDATES_DIR, f), path.join(archiveVersionDir, f)); } catch(e) {}
          });
          console.log(`[ARCHIVE] v${prevVersion} archiviata`);
        }
      }

      const uploadDate = new Date().toISOString();
      console.log(`[RELEASE] v${version} — ${uploadDate}`);

      // Salva metadati
      const meta = { version, fileName: files.installer[0].filename, uploadDate, size: files.installer[0].size, hasBlockmap: !!files.blockmap, hasReadme: !!files.readme };
      fs.writeFileSync(path.join(UPDATES_DIR, 'release-meta.json'), JSON.stringify(meta, null, 2));

      res.json({ success: true, message: `Release v${version} pubblicata con successo!`, version, uploadDate, validation: { yml: true, installer: true, blockmap: !!files.blockmap, readme: !!files.readme } });
    } catch (err) {
      console.error('Errore upload:', err);
      res.status(500).json({ success: false, message: err.message });
    }
  });
});

// LISTA VERSIONI ARCHIVIATE
app.get('/archive-list', (req, res) => {
  try {
    if (!fs.existsSync(ARCHIVE_DIR)) return res.json({ versions: [] });

    const versions = fs.readdirSync(ARCHIVE_DIR)
      .filter(d => fs.statSync(path.join(ARCHIVE_DIR, d)).isDirectory())
      .map(dir => {
        const versionDir = path.join(ARCHIVE_DIR, dir);
        const ymlPath = path.join(versionDir, 'latest.yml');
        const metaPath = path.join(versionDir, 'release-meta.json');
        const parsed = fs.existsSync(ymlPath) ? parseYml(ymlPath) : {};
        let meta = {};
        if (fs.existsSync(metaPath)) { try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch(e) {} }
        const exeFile = fs.readdirSync(versionDir).find(f => f.endsWith('.exe'));
        const exeSize = exeFile ? fs.statSync(path.join(versionDir, exeFile)).size : null;
        const rawDate = meta.uploadDate || parsed.date;
        const validDate = rawDate && !isNaN(new Date(rawDate).getTime()) ? rawDate : null;
        return {
          version: dir.replace('v', ''), dir,
          fileName: exeFile || parsed.fileName,
          date: validDate,
          size: exeSize || meta.size,
          downloadUrl: exeFile ? `/archive/${dir}/${encodeURIComponent(exeFile)}` : null
        };
      })
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));

    res.json({ versions });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// CANCELLA VERSIONE ARCHIVIATA
app.delete('/archive/:version', (req, res) => {
  try {
    const versionDir = path.join(ARCHIVE_DIR, req.params.version);
    if (!fs.existsSync(versionDir)) return res.status(404).json({ success: false, message: 'Versione non trovata' });
    fs.rmSync(versionDir, { recursive: true, force: true });
    console.log(`[ARCHIVE] Versione ${req.params.version} eliminata`);
    res.json({ success: true, message: `Versione ${req.params.version} eliminata` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Errore:', err);
  res.status(500).json({ success: false, message: err.message || 'Errore interno' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n==================================================`);
  console.log(`🚀 MRMSuite Update Server — porta ${PORT}`);
  console.log(`📂 Updates: ${UPDATES_DIR}`);
  console.log(`📦 Archivio: ${ARCHIVE_DIR}`);
  console.log(`🔐 Login: http://localhost:${PORT}/login.html`);
  console.log(`==================================================\n`);
});
