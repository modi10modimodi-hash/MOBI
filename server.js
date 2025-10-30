// ═══════════════════════════════════════════════════════════════
// Cold Room V3.0 - COMPLETE FIXED SERVER
// © 2025 Cold Room - All Rights Reserved
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e8
});

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.use(express.json({ limit: '100mb' }));

const DATA_FILE = 'cold_room_data.json';

// System Settings
let systemSettings = {
  siteLogo: 'https://j.top4top.io/p_3585vud691.jpg',
  siteTitle: 'Cold Room',
  backgroundColor: 'blue',
  loginMusic: '',
  chatMusic: '',
  loginMusicVolume: 0.5,
  chatMusicVolume: 0.5,
  allowImageUpload: true,
  imageUploadMethod: 'both' // 'url', 'file', 'both'
};

// Data storage
const users = new Map();
const rooms = new Map();
const mutedUsers = new Map();
const bannedUsers = new Map();
const privateMessages = new Map();
const supportMessages = new Map();
const onlineUsers = new Map();
const blockedUsers = new Map();
const messageReadStatus = new Map(); // For read receipts

// ═══════════════════════════════════════════════════════════════
// DATA PERSISTENCE
// ═══════════════════════════════════════════════════════════════

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const content = fs.readFileSync(DATA_FILE, 'utf8');
      const loaded = JSON.parse(content);
      
      Object.entries(loaded.users || {}).forEach(([k,v]) => {
        v.lastActivity = Date.now();
        users.set(k, v);
      });
      Object.entries(loaded.rooms || {}).forEach(([k,v]) => {
        // Keep only last 50 messages per room
        if (v.messages && v.messages.length > 50) {
          v.messages = v.messages.slice(-50);
        }
        rooms.set(k, v);
      });
      Object.entries(loaded.mutedUsers || {}).forEach(([k,v]) => mutedUsers.set(k, v));
      Object.entries(loaded.bannedUsers || {}).forEach(([k,v]) => bannedUsers.set(k, v));
      Object.entries(loaded.privateMessages || {}).forEach(([k,v]) => {
        // Keep only last 50 messages per conversation
        const cleanedMessages = {};
        Object.entries(v).forEach(([userId, msgs]) => {
          cleanedMessages[userId] = msgs.slice(-50);
        });
        privateMessages.set(k, cleanedMessages);
      });
      Object.entries(loaded.supportMessages || {}).forEach(([k,v]) => supportMessages.set(k, v));
      Object.entries(loaded.blockedUsers || {}).forEach(([k,v]) => blockedUsers.set(k, new Set(v)));
      
      systemSettings = { ...systemSettings, ...(loaded.systemSettings || {}) };
      console.log('✅ Data loaded successfully');
    } else {
      console.log('⚠️ No data file found, starting fresh');
    }
  } catch (e) {
    console.error('❌ Error loading data:', e);
  }
}

function saveData() {
  try {
    const toSave = {
      users: Object.fromEntries(users),
      rooms: Object.fromEntries(rooms),
      mutedUsers: Object.fromEntries(mutedUsers),
      bannedUsers: Object.fromEntries(bannedUsers),
      privateMessages: Object.fromEntries(privateMessages),
      supportMessages: Object.fromEntries(supportMessages),
      blockedUsers: Object.fromEntries(
        Array.from(blockedUsers.entries()).map(([k, v]) => [k, Array.from(v)])
      ),
      systemSettings
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (e) {
    console.error('❌ Error saving data:', e);
  }
}

// ═══════════════════════════════════════════════════════════════
// INITIALIZE OWNER & GLOBAL ROOM
// ═══════════════════════════════════════════════════════════════

function createOwnerIfMissing() {
  const ownerId = 'owner_cold_001';
  if (!users.has(ownerId)) {
    const owner = {
      id: ownerId,
      username: 'COLDKING',
      displayName: 'Cold Room King',
      password: bcrypt.hashSync('ColdKing@2025', 10),
      isOwner: true,
      avatar: '👑',
      gender: 'prince',
      joinDate: new Date().toISOString(),
      canSendImages: true,
      canSendVideos: true,
      nameChangeCount: 0,
      profilePicture: null,
      lastActivity: Date.now()
    };
    users.set(ownerId, owner);
    privateMessages.set(ownerId, {});
    blockedUsers.set(ownerId, new Set());
    console.log('✅ Owner created: COLDKING / ColdKing@2025');
  }
}

function createGlobalRoomIfMissing() {
  const globalId = 'global_cold';
  if (!rooms.has(globalId)) {
    rooms.set(globalId, {
      id: globalId,
      name: '❄️ Cold Room - Global',
      description: 'Main room for everyone',
      createdBy: 'Cold Room King',
      creatorId: 'owner_cold_001',
      users: [],
      messages: [],
      isOfficial: true,
      moderators: [],
      isSilenced: false,
      hasPassword: false,
      password: null,
      createdAt: new Date().toISOString(),
      videoUrl: null,
      musicUrl: null,
      musicVolume: 0.5,
      partyMode: false
    });
    console.log('✅ Global room created');
  }
}

// ═══════════════════════════════════════════════════════════════
// CLEANUP INACTIVE USERS (10 days)
// ═══════════════════════════════════════════════════════════════

function cleanupInactiveUsers() {
  const tenDaysAgo = Date.now() - (10 * 24 * 60 * 60 * 1000);
  const toDelete = [];
  
  for (const [userId, user] of users.entries()) {
    if (user.isOwner) continue; // Never delete owner
    if (user.lastActivity && user.lastActivity < tenDaysAgo) {
      toDelete.push(userId);
    }
  }
  
  toDelete.forEach(userId => {
    users.delete(userId);
    privateMessages.delete(userId);
    blockedUsers.delete(userId);
    mutedUsers.delete(userId);
    
    rooms.forEach(room => {
      room.users = room.users.filter(u => u !== userId);
      room.moderators = room.moderators.filter(m => m !== userId);
      room.messages = room.messages.filter(msg => msg.userId !== userId);
    });
  });
  
  if (toDelete.length > 0) {
    console.log(`🧹 Cleaned ${toDelete.length} inactive users`);
    saveData();
  }
}

// Run cleanup every 24 hours
setInterval(cleanupInactiveUsers, 24 * 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// INITIALIZE DATA
// ═══════════════════════════════════════════════════════════════

loadData();
createOwnerIfMissing();
createGlobalRoomIfMissing();
saveData();

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/settings', (req, res) => res.json(systemSettings));

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function updateRoomsList() {
  const roomsArray = Array.from(rooms.values()).map(r => ({
    id: r.id,
    name: r.name,
    description: r.description,
    createdBy: r.createdBy,
    creatorId: r.creatorId,
    userCount: (r.users || []).length,
    hasPassword: !!r.hasPassword,
    isOfficial: !!r.isOfficial
  }));
  io.emit('rooms-list', roomsArray);
}

function updateUsersList(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  const usersArray = (room.users || []).map(uid => {
    const u = users.get(uid);
    if (!u) return null;
    return {
      id: u.id,
      displayName: u.displayName,
      avatar: u.avatar,
      profilePicture: u.profilePicture,
      isOwner: !!u.isOwner,
      isModerator: room.moderators.includes(u.id),
      isOnline: onlineUsers.has(u.id)
    };
  }).filter(Boolean);
  
  io.to(roomId).emit('users-list', usersArray);
}

// ═══════════════════════════════════════════════════════════════
// SOCKET CONNECTION
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log('🔗 New connection:', socket.id);
  socket.userIP = socket.handshake.address || '';

  // ═══════════════════════════════════════════════════════════════
  // AUTHENTICATION
  // ═══════════════════════════════════════════════════════════════

  socket.on('login', (payload) => {
    try {
      const { username, password } = payload || {};
      if (!username || !password) return socket.emit('login-error', 'Missing credentials');

      let foundId = null;
      for (const [id, u] of users.entries()) {
        if (u.username.toLowerCase() === username.toLowerCase() &&
            bcrypt.compareSync(password, u.password)) {
          foundId = id;
          break;
        }
      }
      
      if (!foundId) return socket.emit('login-error', 'Invalid credentials');
      if (bannedUsers.has(foundId)) return socket.emit('banned-user', { reason: 'You are banned' });

      const user = users.get(foundId);
      user.lastActivity = Date.now();
      
      socket.userId = foundId;
      socket.userData = user;
      onlineUsers.set(foundId, Date.now());

      const globalRoom = rooms.get('global_cold');
      if (globalRoom && !globalRoom.users.includes(foundId)) {
        globalRoom.users.push(foundId);
      }
      
      socket.join('global_cold');
      socket.currentRoom = 'global_cold';

      const userBlockedList = blockedUsers.get(foundId) || new Set();

      socket.emit('support-messages-list', Array.from(supportMessages.values()));
    } catch (e) {
      console.error('Get support messages error:', e);
    }
  });

  socket.on('delete-support-message', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user?.isOwner) return socket.emit('error', 'Owner only');
      
      supportMessages.delete(payload.messageId);
      user.lastActivity = Date.now();
      
      saveData();
      socket.emit('action-success', 'Message deleted');
    } catch (e) {
      console.error('Delete support message error:', e);
    }
  });

  socket.on('unmute-multiple', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user?.isOwner) return socket.emit('error', 'Owner only');
      
      (payload.userIds || []).forEach(uid => mutedUsers.delete(uid));
      user.lastActivity = Date.now();
      
      saveData();
      socket.emit('action-success', 'Users unmuted');
    } catch (e) {
      console.error('Unmute multiple error:', e);
    }
  });

  socket.on('unban-multiple', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user?.isOwner) return socket.emit('error', 'Owner only');
      
      (payload.userIds || []).forEach(uid => bannedUsers.delete(uid));
      user.lastActivity = Date.now();
      
      saveData();
      socket.emit('action-success', 'Users unbanned');
    } catch (e) {
      console.error('Unban multiple error:', e);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // HEARTBEAT & DISCONNECT
  // ═══════════════════════════════════════════════════════════════

  socket.on('ping', () => {
    try {
      if (socket.userId) {
        onlineUsers.set(socket.userId, Date.now());
        const user = users.get(socket.userId);
        if (user) user.lastActivity = Date.now();
      }
    } catch (e) {
      console.error('Ping error:', e);
    }
  });

  socket.on('disconnect', () => {
    try {
      if (socket.userId) {
        onlineUsers.delete(socket.userId);
        rooms.forEach(room => {
          room.users = (room.users || []).filter(u => u !== socket.userId);
        });
      }
      console.log('🔌 Disconnect:', socket.id);
    } catch (e) {
      console.error('Disconnect error:', e);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// AUTO-SAVE & CLEANUP
// ═══════════════════════════════════════════════════════════════

// Auto-save every 30 seconds
setInterval(() => {
  try {
    saveData();
  } catch (e) {
    console.error('Auto-save error:', e);
  }
}, 30000);

// Keep server alive (for hosting platforms)
setInterval(() => {
  console.log('🔄 Server alive -', new Date().toISOString());
}, 5 * 60 * 1000); // Every 5 minutes

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

server.listen(PORT, () => {
  console.log(`🚀 Cold Room V3.0 - Server running on port ${PORT}`);
  console.log(`✅ Owner: COLDKING / ColdKing@2025`);
  console.log(`✅ All features enabled!`);
  console.log(`✅ Data persistence: ACTIVE`);
  console.log(`✅ Auto-cleanup: ACTIVE (10 days inactivity)`);
});

// ═══════════════════════════════════════════════════════════════
// END - Cold Room V3.0 Complete Server
// © 2025 Cold Room - All Rights Reserved
// ═══════════════════════════════════════════════════════════════

socket.emit('login-success', {
  user: {
    id: foundId,
    username: user.username,
    displayName: user.displayName,
    avatar: user.avatar,
    gender: user.gender,
    isOwner: user.isOwner,
    isModerator: globalRoom ? globalRoom.moderators.includes(foundId) : false,
    canSendImages: user.canSendImages,
    canSendVideos: user.canSendVideos,
    nameChangeCount: user.nameChangeCount || 0,
    profilePicture: user.profilePicture,
  },
  room: {
    id: globalRoom.id,
    name: globalRoom.name,
    messages: (globalRoom.messages || []).slice(-50),
    partyMode: globalRoom.partyMode || false,
    moderators: globalRoom.moderators || [],
    videoUrl: globalRoom.videoUrl,
    musicUrl: globalRoom.musicUrl,
    musicVolume: globalRoom.musicVolume || 0.5
  },
  systemSettings,
  blockedUsers: Array.from(userBlockedList)
});

      updateRoomsList();
      updateUsersList('global_cold');
      saveData();
    } catch (e) {
      console.error('Login error:', e);
      socket.emit('login-error', 'Server error');
    }
  });

  socket.on('register', (payload) => {
    try {
      const { username, password, displayName, gender } = payload || {};
      if (!username || !password || !displayName || !gender) {
        return socket.emit('register-error', 'Missing fields');
      }

      for (const u of users.values()) {
        if (u.username.toLowerCase() === username.toLowerCase()) {
          return socket.emit('register-error', 'Username already exists');
        }
        if (u.displayName.toLowerCase() === displayName.toLowerCase()) {
          return socket.emit('register-error', 'Display name already taken');
        }
      }

      const userId = 'user_' + uuidv4();
      const newUser = {
        id: userId,
        username,
        displayName,
        password: bcrypt.hashSync(password, 10),
        isOwner: false,
        joinDate: new Date().toISOString(),
        avatar: gender === 'prince' ? '🤴' : '👸',
        gender: gender || 'unknown',
        canSendImages: false,
        canSendVideos: false,
        nameChangeCount: 0,
        profilePicture: null,
        lastActivity: Date.now()
      };
      
      users.set(userId, newUser);
      privateMessages.set(userId, {});
      blockedUsers.set(userId, new Set());
      saveData();
      
      socket.emit('register-success', { message: 'Account created successfully!', username });
    } catch (e) {
      console.error('Register error:', e);
      socket.emit('register-error', 'Server error');
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // PROFILE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  socket.on('update-profile-picture', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user) return socket.emit('error', 'Not authenticated');
      
      user.profilePicture = payload.profilePicture || null;
      user.lastActivity = Date.now();
      saveData();
      
      socket.emit('profile-updated', {
        userId: socket.userId,
        profilePicture: user.profilePicture,
        message: 'Profile picture updated'
      });
      
      if (socket.currentRoom) updateUsersList(socket.currentRoom);
    } catch (e) {
      console.error('Update profile error:', e);
    }
  });

  socket.on('change-display-name', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user) return socket.emit('error', 'Not authenticated');
      
      const newName = (payload.newName || '').toString().trim();
      if (!newName || newName.length < 3 || newName.length > 30) {
        return socket.emit('error', 'Name must be 3-30 characters');
      }

      for (const [id, u] of users.entries()) {
        if (id !== socket.userId && u.displayName.toLowerCase() === newName.toLowerCase()) {
          return socket.emit('error', 'Display name already taken');
        }
      }

      if (user.isOwner) {
        user.displayName = newName;
        user.lastActivity = Date.now();
        socket.emit('action-success', 'Name changed successfully');
        saveData();
        if (socket.currentRoom) updateUsersList(socket.currentRoom);
        return;
      }

      const changeCount = user.nameChangeCount || 0;
      if (changeCount >= 2) {
        return socket.emit('error', 'Maximum free changes used');
      }

      user.displayName = newName;
      user.nameChangeCount = changeCount + 1;
      user.lastActivity = Date.now();
      
      const remaining = 2 - user.nameChangeCount;
      socket.emit('action-success', `Name changed! ${remaining} changes remaining`);
      saveData();
      if (socket.currentRoom) updateUsersList(socket.currentRoom);
    } catch (e) {
      console.error('Change name error:', e);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // MESSAGING
  // ═══════════════════════════════════════════════════════════════

  socket.on('send-message', (payload) => {
    try {
      const user = users.get(socket.userId);
      const room = rooms.get(socket.currentRoom);
      if (!user || !room) return socket.emit('error', 'Not in room');

      const mute = mutedUsers.get(socket.userId);
      if (mute && mute.expires && Date.now() > mute.expires) {
        mutedUsers.delete(socket.userId);
      }
      if (mutedUsers.has(socket.userId)) {
        return socket.emit('error', 'You are muted');
      }

      user.lastActivity = Date.now();

      const message = {
        id: 'msg_' + uuidv4(),
        userId: socket.userId,
        username: user.displayName,
        avatar: user.avatar,
        profilePicture: user.profilePicture,
        text: (payload.text || '').toString().substring(0, 1000),
        timestamp: new Date().toLocaleTimeString(),
        date: new Date().toISOString(),
        isOwner: !!user.isOwner,
        isModerator: room.moderators.includes(socket.userId),
        roomId: socket.currentRoom,
        edited: false,
        isImage: false,
        isVideo: false,
        replyTo: payload.replyTo || null
      };
      
      room.messages = room.messages || [];
      room.messages.push(message);
      
      // Keep only last 50 messages
      if (room.messages.length > 50) {
        room.messages = room.messages.slice(-50);
      }
      
      io.to(socket.currentRoom).emit('new-message', message);
      saveData();
    } catch (e) {
      console.error('Send message error:', e);
    }
  });

  socket.on('edit-message', (payload) => {
    try {
      const room = rooms.get(socket.currentRoom);
      if (!room) return;
      
      const idx = (room.messages || []).findIndex(
        m => m.id === payload.messageId && m.userId === socket.userId
      );
      
      if (idx === -1) return socket.emit('error', 'Message not found');
      
      room.messages[idx].text = (payload.newText || '').toString().substring(0, 1000);
      room.messages[idx].edited = true;
      
      io.to(socket.currentRoom).emit('message-edited', {
        messageId: payload.messageId,
        newText: room.messages[idx].text
      });
      
      const user = users.get(socket.userId);
      if (user) user.lastActivity = Date.now();
      
      saveData();
    } catch (e) {
      console.error('Edit message error:', e);
    }
  });

  socket.on('send-image', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user || !user.canSendImages) {
        return socket.emit('error', 'No permission to send images');
      }
      
      const room = rooms.get(socket.currentRoom);
      if (!room) return;

      user.lastActivity = Date.now();

      const message = {
        id: 'msg_' + uuidv4(),
        userId: socket.userId,
        username: user.displayName,
        avatar: user.avatar,
        profilePicture: user.profilePicture,
        imageUrl: payload.imageUrl || '',
        timestamp: new Date().toLocaleTimeString(),
        date: new Date().toISOString(),
        isOwner: !!user.isOwner,
        isModerator: room.moderators.includes(socket.userId),
        roomId: socket.currentRoom,
        isImage: true,
        isVideo: false
      };
      
      room.messages = room.messages || [];
      room.messages.push(message);
      
      if (room.messages.length > 50) {
        room.messages = room.messages.slice(-50);
      }
      
      io.to(socket.currentRoom).emit('new-message', message);
      saveData();
    } catch (e) {
      console.error('Send image error:', e);
    }
  });

  socket.on('send-video', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user || !user.canSendVideos) {
        return socket.emit('error', 'No permission to send videos');
      }
      
      const room = rooms.get(socket.currentRoom);
      if (!room) return;

      user.lastActivity = Date.now();

      const message = {
        id: 'msg_' + uuidv4(),
        userId: socket.userId,
        username: user.displayName,
        avatar: user.avatar,
        profilePicture: user.profilePicture,
        videoUrl: payload.videoUrl || '',
        timestamp: new Date().toLocaleTimeString(),
        date: new Date().toISOString(),
        isOwner: !!user.isOwner,
        isModerator: room.moderators.includes(socket.userId),
        roomId: socket.currentRoom,
        isImage: false,
        isVideo: true
      };
      
      room.messages = room.messages || [];
      room.messages.push(message);
      
      if (room.messages.length > 50) {
        room.messages = room.messages.slice(-50);
      }
      
      io.to(socket.currentRoom).emit('new-message', message);
      saveData();
    } catch (e) {
      console.error('Send video error:', e);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE MESSAGES
  // ═══════════════════════════════════════════════════════════════

  socket.on('send-private-message', (payload) => {
    try {
      const sender = users.get(socket.userId);
      const receiver = users.get(payload.toUserId);
      if (!sender || !receiver) return socket.emit('error', 'Invalid users');

      // Check if sender is blocked
      const receiverBlocked = blockedUsers.get(payload.toUserId) || new Set();
      if (receiverBlocked.has(socket.userId) && !sender.isOwner) {
        return socket.emit('error', 'You are blocked by this user');
      }

      sender.lastActivity = Date.now();

      const message = {
        id: 'pm_' + uuidv4(),
        from: socket.userId,
        to: payload.toUserId,
        fromName: sender.displayName,
        text: (payload.text || '').toString().substring(0, 1000),
        timestamp: new Date().toLocaleTimeString(),
        date: new Date().toISOString(),
        edited: false,
        read: false,
        replyTo: payload.replyTo || null
      };

      // Save to sender's messages
      if (!privateMessages.has(socket.userId)) privateMessages.set(socket.userId, {});
      const smap = privateMessages.get(socket.userId);
      if (!smap[payload.toUserId]) smap[payload.toUserId] = [];
      smap[payload.toUserId].push(message);
      
      // Keep only last 50 messages
      if (smap[payload.toUserId].length > 50) {
        smap[payload.toUserId] = smap[payload.toUserId].slice(-50);
      }

      // Save to receiver's messages
      if (!privateMessages.has(payload.toUserId)) privateMessages.set(payload.toUserId, {});
      const rmap = privateMessages.get(payload.toUserId);
      if (!rmap[socket.userId]) rmap[socket.userId] = [];
      rmap[socket.userId].push(message);
      
      if (rmap[socket.userId].length > 50) {
        rmap[socket.userId] = rmap[socket.userId].slice(-50);
      }

      // Send to receiver if online
      const receiverSocket = Array.from(io.sockets.sockets.values())
        .find(s => s.userId === payload.toUserId);
      if (receiverSocket) {
        receiverSocket.emit('new-private-message', message);
      }

      socket.emit('private-message-sent', message);
      saveData();
    } catch (e) {
      console.error('Send private message error:', e);
    }
  });

  socket.on('get-private-messages', (payload) => {
    try {
      const list = privateMessages.get(socket.userId)?.[payload.withUserId] || [];
      
      // Mark messages as read
      list.forEach(msg => {
        if (msg.to === socket.userId) {
          msg.read = true;
        }
      });
      
      socket.emit('private-messages-list', { 
        withUserId: payload.withUserId, 
        messages: list.slice(-50)
      });
      
      saveData();
    } catch (e) {
      console.error('Get private messages error:', e);
    }
  });

  socket.on('block-user', (payload) => {
    try {
      const user = users.get(socket.userId);
      const targetUser = users.get(payload.userId);
      
      // Owner cannot be blocked
      if (targetUser && targetUser.isOwner) {
        return socket.emit('error', 'Cannot block the owner');
      }
      
      if (!blockedUsers.has(socket.userId)) {
        blockedUsers.set(socket.userId, new Set());
      }
      blockedUsers.get(socket.userId).add(payload.userId);
      
      if (user) user.lastActivity = Date.now();
      
      saveData();
      socket.emit('action-success', 'User blocked');
    } catch (e) {
      console.error('Block user error:', e);
    }
  });

  socket.on('unblock-user', (payload) => {
    try {
      if (blockedUsers.has(socket.userId)) {
        blockedUsers.get(socket.userId).delete(payload.userId);
        saveData();
      }
      
      const user = users.get(socket.userId);
      if (user) user.lastActivity = Date.now();
      
      socket.emit('action-success', 'User unblocked');
    } catch (e) {
      console.error('Unblock user error:', e);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ROOM MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  socket.on('create-room', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user) return socket.emit('error', 'Not authenticated');
      
      user.lastActivity = Date.now();
      
      const roomId = 'room_' + uuidv4();
      const newRoom = {
        id: roomId,
        name: (payload.name || 'Untitled').toString().substring(0, 100),
        description: (payload.description || '').toString().substring(0, 500),
        createdBy: user.displayName,
        creatorId: socket.userId,
        users: [socket.userId],
        messages: [],
        isOfficial: false,
        hasPassword: !!payload.password,
        password: payload.password ? bcrypt.hashSync(payload.password.toString(), 10) : null,
        moderators: [],
        isSilenced: false,
        createdAt: new Date().toISOString(),
        videoUrl: null,
        musicUrl: null,
        musicVolume: 0.5,
        partyMode: false
      };
      
      rooms.set(roomId, newRoom);
      socket.join(roomId);
      socket.currentRoom = roomId;
      
      socket.emit('room-created', { roomId, roomName: newRoom.name });
      updateRoomsList();
      saveData();
    } catch (e) {
      console.error('Create room error:', e);
    }
  });

  socket.on('join-room', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user) return socket.emit('error', 'Not authenticated');
      
      const room = rooms.get(payload.roomId);
      if (!room) return socket.emit('error', 'Room not found');

      // Check password
      if (room.hasPassword && !user.isOwner) {
        if (!payload.password || !bcrypt.compareSync(payload.password.toString(), room.password)) {
          return socket.emit('error', 'Wrong password');
        }
      }

      // Leave previous room
      if (socket.currentRoom) {
        const prev = rooms.get(socket.currentRoom);
        if (prev) {
          prev.users = (prev.users || []).filter(u => u !== socket.userId);
        }
        socket.leave(socket.currentRoom);
      }

      // Join new room
      if (!room.users.includes(socket.userId)) {
        room.users.push(socket.userId);
      }
      
      socket.join(room.id);
      socket.currentRoom = room.id;
      
      user.lastActivity = Date.now();

      socket.emit('room-joined', {
        room: {
          id: room.id,
          name: room.name,
          description: room.description,
          messages: (room.messages || []).slice(-50),
          isCreator: room.creatorId === socket.userId,
          isModerator: room.moderators.includes(socket.userId),
          partyMode: room.partyMode || false,
          moderators: room.moderators || [],
          videoUrl: room.videoUrl,
          musicUrl: room.musicUrl,
          musicVolume: room.musicVolume || 0.5
        }
      });

      updateUsersList(room.id);
      saveData();
    } catch (e) {
      console.error('Join room error:', e);
    }
  });

  socket.on('update-room', (payload) => {
    try {
      const user = users.get(socket.userId);
      const room = rooms.get(payload.roomId);
      
      if (!room) return socket.emit('error', 'Room not found');
      
      // Only owner or room creator can update
      if (!user.isOwner && room.creatorId !== socket.userId) {
        return socket.emit('error', 'No permission');
      }
      
      if (payload.name !== undefined) {
        room.name = payload.name.toString().substring(0, 100);
      }
      if (payload.description !== undefined) {
        room.description = payload.description.toString().substring(0, 500);
      }
      if (payload.password !== undefined) {
        room.hasPassword = !!payload.password;
        room.password = payload.password ? bcrypt.hashSync(payload.password.toString(), 10) : null;
      }
      
      user.lastActivity = Date.now();
      
      io.to(room.id).emit('room-updated', { 
        name: room.name, 
        description: room.description 
      });
      
      updateRoomsList();
      saveData();
      socket.emit('action-success', 'Room updated');
    } catch (e) {
      console.error('Update room error:', e);
    }
  });

  socket.on('delete-room', (payload) => {
    try {
      const user = users.get(socket.userId);
      const room = rooms.get(payload.roomId);
      
      if (!room || room.isOfficial) {
        return socket.emit('error', 'Cannot delete this room');
      }
      
      // Only owner or room creator can delete
      if (!user.isOwner && room.creatorId !== socket.userId) {
        return socket.emit('error', 'No permission');
      }
      
      io.to(payload.roomId).emit('room-deleted', { 
        message: 'Room has been deleted' 
      });
      
      rooms.delete(payload.roomId);
      user.lastActivity = Date.now();
      
      updateRoomsList();
      saveData();
      socket.emit('action-success', 'Room deleted');
    } catch (e) {
      console.error('Delete room error:', e);
    }
  });

  socket.on('silence-room', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user?.isOwner) return socket.emit('error', 'Owner only');
      
      const room = rooms.get(payload.roomId);
      if (!room) return socket.emit('error', 'Room not found');
      
      room.isSilenced = true;
      user.lastActivity = Date.now();
      
      io.to(payload.roomId).emit('room-silenced', { 
        message: 'Room has been silenced', 
        forceDisable: true 
      });
      
      saveData();
    } catch (e) {
      console.error('Silence room error:', e);
    }
  });

  socket.on('unsilence-room', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user?.isOwner) return socket.emit('error', 'Owner only');
      
      const room = rooms.get(payload.roomId);
      if (!room) return socket.emit('error', 'Room not found');
      
      room.isSilenced = false;
      user.lastActivity = Date.now();
      
      io.to(payload.roomId).emit('room-unsilenced', { 
        message: 'Room silencing removed' 
      });
      
      saveData();
    } catch (e) {
      console.error('Unsilence room error:', e);
    }
  });

  socket.on('clean-chat', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user?.isOwner) return socket.emit('error', 'Owner only');
      
      const room = rooms.get(payload.roomId);
      if (!room) return socket.emit('error', 'Room not found');
      
      room.messages = [];
      user.lastActivity = Date.now();
      
      io.to(payload.roomId).emit('chat-cleaned', { 
        message: 'Chat has been cleaned' 
      });
      
      saveData();
    } catch (e) {
      console.error('Clean chat error:', e);
    }
  });

  socket.on('clean-all-rooms', () => {
    try {
      const user = users.get(socket.userId);
      if (!user?.isOwner) return socket.emit('error', 'Owner only');
      
      rooms.forEach(room => {
        room.messages = [];
        io.to(room.id).emit('chat-cleaned', { 
          message: 'All rooms cleaned' 
        });
      });
      
      user.lastActivity = Date.now();
      saveData();
      socket.emit('action-success', 'All rooms cleaned');
    } catch (e) {
      console.error('Clean all rooms error:', e);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ROOM MEDIA (Per-Room Video & Music)
  // ═══════════════════════════════════════════════════════════════

  socket.on('get-room-media', (payload) => {
    try {
      const room = rooms.get(payload.roomId);
      if (!room) return socket.emit('error', 'Room not found');
      
      socket.emit('room-media-data', {
        roomId: room.id,
        videoUrl: room.videoUrl,
        musicUrl: room.musicUrl,
        musicVolume: room.musicVolume || 0.5
      });
    } catch (e) {
      console.error('Get room media error:', e);
    }
  });

  socket.on('update-room-media', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user?.isOwner) return socket.emit('error', 'Owner only');
      
      const room = rooms.get(payload.roomId);
      if (!room) return socket.emit('error', 'Room not found');

      if (payload.type === 'video') {
        room.videoUrl = payload.videoUrl || null;
        io.to(payload.roomId).emit('room-media-updated', {
          roomId: payload.roomId,
          type: 'video',
          videoUrl: room.videoUrl,
          message: room.videoUrl ? 'Room video updated' : 'Room video removed'
        });
      } else if (payload.type === 'music') {
        room.musicUrl = payload.musicUrl || null;
        room.musicVolume = payload.musicVolume || 0.5;
        io.to(payload.roomId).emit('room-media-updated', {
          roomId: payload.roomId,
          type: 'music',
          musicUrl: room.musicUrl,
          musicVolume: room.musicVolume,
          message: room.musicUrl ? 'Room music updated' : 'Room music removed'
        });
      }

      user.lastActivity = Date.now();
      saveData();
    } catch (e) {
      console.error('Update room media error:', e);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // PARTY MODE (Per-Room)
  // ═══════════════════════════════════════════════════════════════

  socket.on('toggle-party-mode', (payload) => {
    try {
      const user = users.get(socket.userId);
      const room = rooms.get(payload.roomId || socket.currentRoom);
      
      if (!user || !room) return socket.emit('error', 'Invalid request');
      
      // Only owner or moderators can toggle
      const allowed = user.isOwner || room.moderators.includes(socket.userId);
      if (!allowed) return socket.emit('error', 'No permission');
      
      room.partyMode = !!payload.enabled;
      user.lastActivity = Date.now();
      
      io.to(room.id).emit('party-mode-changed', {
        enabled: room.partyMode,
        roomId: room.id
      });
      
      saveData();
    } catch (e) {
      console.error('Toggle party mode error:', e);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // MODERATION
  // ═══════════════════════════════════════════════════════════════

  socket.on('mute-user', (payload) => {
    try {
      const admin = users.get(socket.userId);
      const target = users.get(payload.userId);
      
      if (!admin || !target) return socket.emit('error', 'Invalid users');
      if (target.isOwner) return socket.emit('error', 'Cannot mute owner');

      const durationMin = parseInt(payload.duration) || 0;
      const expires = durationMin > 0 ? Date.now() + durationMin * 60000 : null;
      
      mutedUsers.set(payload.userId, {
        username: target.displayName,
        expires,
        reason: payload.reason || 'Rule violation',
        mutedBy: admin.displayName,
        mutedById: socket.userId,
        temporary: !!expires,
        byOwner: !!admin.isOwner,
        roomId: payload.roomId || socket.currentRoom
      });
      
      admin.lastActivity = Date.now();
      saveData();
      socket.emit('action-success', `Muted ${target.displayName}`);
    } catch (e) {
      console.error('Mute user error:', e);
    }
  });

  socket.on('unmute-user', (payload) => {
    try {
      const admin = users.get(socket.userId);
      if (!admin) return socket.emit('error', 'Not authenticated');
      
      const muteInfo = mutedUsers.get(payload.userId);
      if (!muteInfo) return socket.emit('action-success', 'User not muted');

      if (admin.isOwner) {
        mutedUsers.delete(payload.userId);
        admin.lastActivity = Date.now();
        saveData();
        return socket.emit('action-success', 'User unmuted');
      }

      if (admin.isModerator && (muteInfo.mutedById === socket.userId || !muteInfo.byOwner)) {
        mutedUsers.delete(payload.userId);
        admin.lastActivity = Date.now();
        saveData();
        return socket.emit('action-success', 'User unmuted');
      }

      socket.emit('error', 'You can only unmute users you muted');
    } catch (e) {
      console.error('Unmute user error:', e);
    }
  });

  socket.on('ban-user', (payload) => {
    try {
      const admin = users.get(socket.userId);
      const target = users.get(payload.userId);
      
      if (!admin?.isOwner) return socket.emit('error', 'Owner only');
      if (!target || target.isOwner) return socket.emit('error', 'Invalid target');
      
      bannedUsers.set(payload.userId, {
        username: target.displayName,
        reason: payload.reason || 'Violation',
        bannedBy: admin.displayName,
        bannedAt: Date.now()
      });
      
      admin.lastActivity = Date.now();
      saveData();
      
      const targetSocket = Array.from(io.sockets.sockets.values())
        .find(s => s.userId === payload.userId);
      if (targetSocket) {
        try {
          targetSocket.emit('banned', { reason: payload.reason || 'Violation' });
          targetSocket.disconnect(true);
        } catch {}
      }
      
      socket.emit('action-success', `Banned ${target.displayName}`);
    } catch (e) {
      console.error('Ban user error:', e);
    }
  });

  socket.on('unban-user', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user?.isOwner) return socket.emit('error', 'Owner only');
      
      bannedUsers.delete(payload.userId);
      user.lastActivity = Date.now();
      saveData();
      socket.emit('action-success', 'User unbanned');
    } catch (e) {
      console.error('Unban user error:', e);
    }
  });

  socket.on('delete-account', (payload) => {
    try {
      const admin = users.get(socket.userId);
      if (!admin?.isOwner) return socket.emit('error', 'Owner only');
      
      const target = users.get(payload.userId);
      if (!target || target.isOwner) return socket.emit('error', 'Invalid target');

      // Remove from all rooms
      rooms.forEach(room => {
        room.messages = room.messages.filter(m => m.userId !== payload.userId);
        room.users = room.users.filter(u => u !== payload.userId);
        room.moderators = room.moderators.filter(m => m !== payload.userId);
      });

      users.delete(payload.userId);
      privateMessages.delete(payload.userId);
      mutedUsers.delete(payload.userId);
      bannedUsers.delete(payload.userId);
      blockedUsers.delete(payload.userId);

      const targetSocket = Array.from(io.sockets.sockets.values())
        .find(s => s.userId === payload.userId);
      if (targetSocket) {
        try {
          targetSocket.emit('account-deleted', { message: 'Account deleted' });
          targetSocket.disconnect(true);
        } catch {}
      }
      
      admin.lastActivity = Date.now();
      saveData();
      updateRoomsList();
      socket.emit('action-success', 'Account deleted');
    } catch (e) {
      console.error('Delete account error:', e);
    }
  });

  socket.on('delete-message', (payload) => {
    try {
      const admin = users.get(socket.userId);
      if (!admin?.isOwner) return socket.emit('error', 'Owner only');
      
      const room = rooms.get(payload.roomId);
      if (!room) return socket.emit('error', 'Room not found');
      
      room.messages = room.messages.filter(m => m.id !== payload.messageId);
      admin.lastActivity = Date.now();
      
      io.to(payload.roomId).emit('message-deleted', { messageId: payload.messageId });
      saveData();
    } catch (e) {
      console.error('Delete message error:', e);
    }
  });

  socket.on('add-moderator', (payload) => {
    try {
      const admin = users.get(socket.userId);
      if (!admin?.isOwner) return socket.emit('error', 'Owner only');
      
      const room = rooms.get(payload.roomId);
      if (!room) return socket.emit('error', 'Room not found');
      
      if (!room.moderators.includes(payload.userId)) {
        room.moderators.push(payload.userId);
      }
      
      admin.lastActivity = Date.now();
      saveData();
      socket.emit('action-success', `${payload.username} is now moderator`);
    } catch (e) {
      console.error('Add moderator error:', e);
    }
  });

  socket.on('remove-moderator', (payload) => {
    try {
      const admin = users.get(socket.userId);
      if (!admin?.isOwner) return socket.emit('error', 'Owner only');
      
      const room = rooms.get(payload.roomId);
      if (!room) return socket.emit('error', 'Room not found');
      
      room.moderators = room.moderators.filter(id => id !== payload.userId);
      admin.lastActivity = Date.now();
      
      saveData();
      socket.emit('action-success', `${payload.username} removed from moderators`);
    } catch (e) {
      console.error('Remove moderator error:', e);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // SYSTEM SETTINGS
  // ═══════════════════════════════════════════════════════════════

  socket.on('update-settings', (payload) => {
    try {
      const user = users.get(socket.userId);
      if (!user?.isOwner) return socket.emit('error', 'Owner only');
      
      if (payload.siteLogo !== undefined) systemSettings.siteLogo = payload.siteLogo;
      if (payload.siteTitle !== undefined) systemSettings.siteTitle = payload.siteTitle;
      if (payload.backgroundColor !== undefined) systemSettings.backgroundColor = payload.backgroundColor;
      if (payload.loginMusic !== undefined) systemSettings.loginMusic = payload.loginMusic;
      if (payload.chatMusic !== undefined) systemSettings.chatMusic = payload.chatMusic;
      if (payload.loginMusicVolume !== undefined) systemSettings.loginMusicVolume = Number(payload.loginMusicVolume) || 0.5;
      if (payload.chatMusicVolume !== undefined) systemSettings.chatMusicVolume = Number(payload.chatMusicVolume) || 0.5;
      if (payload.allowImageUpload !== undefined) systemSettings.allowImageUpload = payload.allowImageUpload;
      if (payload.imageUploadMethod !== undefined) systemSettings.imageUploadMethod = payload.imageUploadMethod;
      
      user.lastActivity = Date.now();
      saveData();
      
      io.emit('settings-updated', systemSettings);
      socket.emit('action-success', 'Settings updated');
    } catch (e) {
      console.error('Update settings error:', e);
    }
  });

  socket.on('toggle-user-image-permission', (payload) => {
    try {
      const admin = users.get(socket.userId);
      if (!admin?.isOwner) return socket.emit('error', 'Owner only');
      
      const target = users.get(payload.userId);
      if (!target) return socket.emit('error', 'User not found');
      
      target.canSendImages = payload.allowed;
      admin.lastActivity = Date.now();
      
      saveData();
      socket.emit('action-success', `Image permission ${payload.allowed ? 'granted' : 'revoked'}`);
    } catch (e) {
      console.error('Toggle image permission error:', e);
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // LISTS & SUPPORT
  // ═══════════════════════════════════════════════════════════════

  socket.on('get-rooms', () => {
    try {
      const roomsArray = Array.from(rooms.values()).map(r => ({
        id: r.id,
        name: r.name,
        description: r.description,
        userCount: (r.users || []).length,
        hasPassword: !!r.hasPassword,
        isOfficial: !!r.isOfficial,
        createdBy: r.createdBy,
        creatorId: r.creatorId
      })).sort((a, b) => {
        if (a.isOfficial && !b.isOfficial) return -1;
        if (!a.isOfficial && b.isOfficial) return 1;
        return b.userCount - a.userCount;
      });
      socket.emit('rooms-list', roomsArray);
    } catch (e) {
      console.error('Get rooms error:', e);
    }
  });

  socket.on('get-users', (payload) => {
    try {
      const room = rooms.get(payload.roomId);
      if (!room) return socket.emit('users-list', []);
      
      const usersArray = (room.users || []).map(uid => {
        const u = users.get(uid);
        if (!u) return null;
        return {
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          avatar: u.avatar,
          profilePicture: u.profilePicture,
          isOnline: onlineUsers.has(u.id),
          isOwner: !!u.isOwner,
          isModerator: room.moderators.includes(u.id)
        };
      }).filter(Boolean);
      
      socket.emit('users-list', usersArray);
    } catch (e) {
      console.error('Get users error:', e);
    }
  });

  socket.on('get-muted-list', () => {
    try {
      const user = users.get(socket.userId);
      if (!user || (!user.isOwner && !user.isModerator)) {
        return socket.emit('error', 'No permission');
      }
      
      let list = Array.from(mutedUsers.entries())
        .map(([uid, info]) => ({ userId: uid, ...info }));
      
      if (user.isModerator && !user.isOwner) {
        list = list.filter(item => item.mutedById === socket.userId || !item.byOwner);
      }
      
      socket.emit('muted-list', list);
    } catch (e) {
      console.error('Get muted list error:', e);
    }
  });

  socket.on('get-banned-list', () => {
    try {
      const user = users.get(socket.userId);
      if (!user?.isOwner) return socket.emit('error', 'Owner only');
      
      const list = Array.from(bannedUsers.entries())
        .map(([uid, info]) => ({ userId: uid, ...info }));
      socket.emit('banned-list', list);
    } catch (e) {
      console.error('Get banned list error:', e);
    }
  });

  socket.on('send-support-message', (payload) => {
    try {
      const id = 'support_' + uuidv4();
      supportMessages.set(id, {
        id,
        from: payload.from || 'Anonymous',
        message: (payload.message || '').toString().substring(0, 1000),
        sentAt: new Date().toISOString(),
        fromIP: socket.userIP || ''
      });
      
      const user = users.get(socket.userId);
      if (user) user.lastActivity = Date.now();
      
      saveData();
      socket.emit('support-message-sent', { message: 'Message sent to owner' });
    } catch (e) {
      console.error('Send support message error:', e);
    }
  });

  socket.on('get-support-messages', () => {
    try {
      const user = users.get(socket.userId);
      if (!user?.isOwner) return socket.emit('error', 'Owner only');
      
      socket.emit
