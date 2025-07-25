const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs');
require('dotenv').config();

const app = express();

// app comfig
const USERNAME = 'admin';
const PASSWORD = 'admin';
const EMAIL_LIMIT = 10; // max email
const EMAIL_LOG_FILE = path.join(__dirname, 'email_log.json'); // stores timestamps

// helpers
function ensureEmailLogFile() {
    if (!fs.existsSync(EMAIL_LOG_FILE)) {
        fs.writeFileSync(EMAIL_LOG_FILE, JSON.stringify([], null, 2));
    }
}

function loadEmailLog() {
    ensureEmailLogFile();
    const data = fs.readFileSync(EMAIL_LOG_FILE, 'utf-8').trim();
    if (!data) return [];
    try {
        return JSON.parse(data);
    } catch (err) {
        console.error('email_log.json. Resetting to [].');
        saveEmailLog([]);
        return [];
    }
}

function saveEmailLog(log) {
    fs.writeFileSync(EMAIL_LOG_FILE, JSON.stringify(log, null, 2));
}

function filterLast24Hours(log) {
    const now = Date.now();
    return log.filter((ts) => now - ts < 24 * 60 * 60 * 1000);
}

function countEmailsLast24Hours() {
    const log = filterLast24Hours(loadEmailLog());
    saveEmailLog(log); // clean old timestamps
    return log.length;
}

function addEmailTimestamp() {
    const log = filterLast24Hours(loadEmailLog());
    log.push(Date.now());
    saveEmailLog(log);
}

function timeUntilReset() {
    const log = filterLast24Hours(loadEmailLog());
    if (log.length < EMAIL_LIMIT) return 0;
    const oldest = log[0];
    return 24 * 60 * 60 * 1000 - (Date.now() - oldest);
}

function msToHhMm(ms) {
    if (ms <= 0) return { h: 0, m: 0 };
    const h = Math.floor(ms / (60 * 60 * 1000));
    const m = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
    return { h, m };
}

// middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
    session({
        secret: process.env.SESSION_SECRET || 'secret-key',
        resave: false,
        saveUninitialized: false,
    })
);

const view = (file) => path.join(__dirname, 'views', file);

// auth guard
function requireAuth(req, res, next) {
    if (req.session.user) return next();
    res.redirect('/login');
}

// uploads attachments
const upload = multer({ dest: 'uploads/' });

// add css path
app.use(express.static(path.join(__dirname, 'public')));

// routes
app.get('/', (req, res) => res.redirect('/dashboard'));

app.get('/login', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.sendFile(view('login.html'));
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === USERNAME && password === PASSWORD) {
        req.session.user = { username };
        return res.redirect('/dashboard');
    }
    return res.redirect('/login?error=1');
});

app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(view('dashboard.html'));
});

// ajax email count and reset time
app.get('/email-count', requireAuth, (req, res) => {
    const count = countEmailsLast24Hours();
    const remaining = Math.max(EMAIL_LIMIT - count, 0);
    const ms = timeUntilReset();
    const { h, m } = msToHhMm(ms);

    res.json({
        count,// email send in last 24 hours
        limit: EMAIL_LIMIT,
        remaining,// total email send
        resetInMs: ms,
        resetInHuman: `${h}h ${m}m`,
    });
});

app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// send email
app.post('/send-email', requireAuth, upload.single('attachment'), async (req, res) => {
    const { to, cc, subject, body } = req.body;
    const attachmentFile = req.file;

    // 24h limit
    const alreadySent = countEmailsLast24Hours();
    if (alreadySent >= EMAIL_LIMIT) {
        const ms = timeUntilReset();
        const { h, m } = msToHhMm(ms);
        if (attachmentFile && fs.existsSync(attachmentFile.path)) fs.unlinkSync(attachmentFile.path);
        return res
        .status(429)
        .send(
            `<p>Email NOT sent. You have reached the limit of ${EMAIL_LIMIT} emails in 24 hours.</p>
            <p>Your limit will reset in about ${h}h ${m}m.</p>
            <a href="/dashboard">Back</a>`
        );
    }

    try {
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_SERVER,
            port: Number(process.env.SMTP_PORT),
            secure: false,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });

        const mailOptions = {
            from: process.env.SENDER_EMAIL,
            to,
            cc: cc || '',
            subject,
            html: body,
            attachments: attachmentFile
                ? [
                    {
                        filename: attachmentFile.originalname,
                        path: attachmentFile.path,
                    },
                ]
                : [],
        };

        await transporter.sendMail(mailOptions);

        if (attachmentFile && fs.existsSync(attachmentFile.path)) fs.unlinkSync(attachmentFile.path);

        // counter++
        addEmailTimestamp();

        res.send('<p>Email sent successfully!</p><a href="/dashboard">Back</a>');
    } catch (err) {
        console.error(err);
        if (attachmentFile && fs.existsSync(attachmentFile.path)) fs.unlinkSync(attachmentFile.path);
        res.status(500).send('<p>Failed to send email.</p><a href="/dashboard">Back</a>');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    ensureEmailLogFile();
});
