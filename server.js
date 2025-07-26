const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage for rooms
const rooms = {};

// Generate random room code
function generateRoomCode() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// WebSocket connection handling
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message.toString());
            if (data.type === 'join') {
                ws.roomCode = data.roomCode;
                ws.user = data.user;
                ws.isAdmin = data.isAdmin;
                console.log(`User ${ws.user} joined room ${ws.roomCode}`);
            } else if (data.type === 'poll') {
                const room = rooms[data.roomCode];
                if (room) {
                    room.currentQuestion = data.question;
                    room.questions.push(data.question);
                    room.timer = data.question.timer;
                    broadcast(data.roomCode, { type: 'poll', question: room.currentQuestion });
                    startTimer(data.roomCode, room.timer);
                }
            } else if (data.type === 'answer') {
                const room = rooms[data.roomCode];
                if (room && room.currentQuestion) {
                    room.currentQuestion.responses[data.user] = data.answer;
                    room.students[data.user].answers[room.questions.length - 1] = data.answer;
                    if (room.currentQuestion.correctAnswer && data.answer === room.currentQuestion.correctAnswer) {
                        room.students[data.user].score = (room.students[data.user].score || 0) + 1;
                    }
                    broadcast(data.roomCode, { type: 'update', room });
                }
            } else if (data.type === 'hint') {
                const room = rooms[data.roomCode];
                if (room && room.currentQuestion && ws.isAdmin) {
                    room.currentQuestion.hint = data.hint;
                    broadcast(data.roomCode, { type: 'hint', hint: data.hint });
                }
            } else if (data.type === 'reaction') {
                const room = rooms[data.roomCode];
                if (room && room.currentQuestion && !ws.isAdmin) {
                    room.currentQuestion.reactions = room.currentQuestion.reactions || {};
                    room.currentQuestion.reactions[data.reaction] = (room.currentQuestion.reactions[data.reaction] || 0) + 1;
                    broadcast(data.roomCode, { type: 'reactions', reactions: room.currentQuestion.reactions });
                }
            } else if (data.type === 'skipVote') {
                const room = rooms[data.roomCode];
                if (room && room.currentQuestion && !ws.isAdmin) {
                    room.currentQuestion.skipVotes = room.currentQuestion.skipVotes || {};
                    if (!room.currentQuestion.skipVotes[data.user]) {
                        room.currentQuestion.skipVotes[data.user] = true;
                        const studentCount = Object.keys(room.students).length;
                        const voteCount = Object.keys(room.currentQuestion.skipVotes).length;
                        if (studentCount > 0 && voteCount / studentCount >= 0.5) {
                            room.currentQuestion = null;
                            room.timer = 0;
                            broadcast(data.roomCode, { type: 'poll', question: null });
                            broadcast(data.roomCode, { type: 'alert', message: 'Question skipped due to majority vote!' });
                        } else {
                            broadcast(data.roomCode, { type: 'skipUpdate', votes: voteCount, total: studentCount });
                        }
                    }
                }
            } else if (data.type === 'adjustTimer') {
                const room = rooms[data.roomCode];
                if (room && room.currentQuestion && ws.isAdmin) {
                    room.timer = Math.max(10, room.timer + data.delta);
                    broadcast(data.roomCode, { type: 'timer', timer: room.timer });
                }
            } else if (data.type === 'feedback') {
                const room = rooms[data.roomCode];
                if (room && room.currentQuestion && !ws.isAdmin) {
                    room.currentQuestion.feedback = room.currentQuestion.feedback || [];
                    if (data.feedback.length <= 100) {
                        room.currentQuestion.feedback.push(data.feedback);
                        broadcast(data.roomCode, { type: 'feedback', feedback: room.currentQuestion.feedback });
                    }
                }
            }
        } catch (err) {
            console.error('WebSocket message error:', err.message);
        }
    });

    ws.on('close', () => {
        if (ws.roomCode && ws.user && !ws.isAdmin) {
            const room = rooms[ws.roomCode];
            if (room) {
                delete room.students[ws.user];
                broadcast(ws.roomCode, { type: 'update', room });
            }
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
    });
});

// Broadcast to all clients in a room
function broadcast(roomCode, message) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.roomCode === roomCode) {
            try {
                client.send(JSON.stringify(message));
            } catch (err) {
                console.error('Broadcast error:', err.message);
            }
        }
    });
}

// Timer handling
function startTimer(roomCode, seconds) {
    const room = rooms[roomCode];
    if (!room) return;
    room.timer = seconds;
    const interval = setInterval(() => {
        if (!room || !room.currentQuestion) {
            clearInterval(interval);
            return;
        }
        room.timer--;
        broadcast(roomCode, { type: 'timer', timer: room.timer });
        if (room.timer <= 0) {
            clearInterval(interval);
            if (room) {
                room.currentQuestion = null;
                broadcast(roomCode, { type: 'poll', question: null });
            }
        }
    }, 1000);
}

// API routes
app.post('/create-room', (req, res) => {
    try {
        const { adminName } = req.body;
        if (!adminName) return res.status(400).json({ error: 'Admin name required' });
        const roomCode = generateRoomCode();
        rooms[roomCode] = {
            code: roomCode,
            admin: adminName,
            questions: [],
            students: {},
            currentQuestion: null,
            timer: 0
        };
        console.log(`Room ${roomCode} created by ${adminName}`);
        res.json({ roomCode });
    } catch (err) {
        console.error('Create room error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/join-room', (req, res) => {
    try {
        const { roomCode, studentName } = req.body;
        if (!roomCode || !studentName) return res.status(400).json({ error: 'Room code and name required' });
        const room = rooms[roomCode];
        if (!room) return res.status(404).json({ error: 'Invalid room code' });
        if (room.students[studentName]) return res.status(400).json({ error: 'Student name already taken' });
        room.students[studentName] = { answers: {}, score: 0 };
        broadcast(roomCode, { type: 'update', room });
        console.log(`Student ${studentName} joined room ${roomCode}`);
        res.json({ success: true });
    } catch (err) {
        console.error('Join room error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/end-room', (req, res) => {
    try {
        const { roomCode } = req.body;
        if (rooms[roomCode]) {
            delete rooms[roomCode];
            broadcast(roomCode, { type: 'end' });
            console.log(`Room ${roomCode} ended`);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Room not found' });
        }
    } catch (err) {
        console.error('End room error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/room/:roomCode', (req, res) => {
    try {
        const room = rooms[req.params.roomCode];
        if (!room) return res.status(404).json({ error: 'Room not found' });
        res.json(room);
    } catch (err) {
        console.error('Get room error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Serve index.html
app.get('/', (req, res) => {
    try {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } catch (err) {
        console.error('Serve index error:', err.message);
        res.status(500).send('Server error');
    }
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Express error:', err.message);
    res.status(500).json({ error: 'Server error' });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err.message);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, (err) => {
    if (err) {
        console.error('Server startup error:', err.message);
        process.exit(1);
    }
    console.log(`Server running on port ${PORT}`);
});