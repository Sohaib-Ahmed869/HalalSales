const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "your_secret_key"; // ← must match auth.js exactly

let io = null;

// Admins and sales managers share this room — the RFQ "needs attention" badge is
// a single global count, not a per-user one.
const RFQ_ATTENTION_ROOM = "rfq:attention";

const initSocket = (httpServer) => {
    io = new Server(httpServer, {
        cors: {
            origin: process.env.FRONTEND_URL || "http://localhost:5173",
            methods: ["GET", "POST"],
            credentials: true,
        },
        transports: ["websocket", "polling"],
    });

    io.use((socket, next) => {
        const token =
            socket.handshake.auth?.token ||
            socket.handshake.headers?.authorization?.replace("Bearer ", "");

        if (!token) return next(new Error("Unauthorized: no token"));

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            socket.userId = decoded.userId; // ← your middleware uses decoded.userId
            if (!socket.userId) return next(new Error("Unauthorized: no userId in token"));
            next();
        } catch (err) {
            console.error("[Socket] JWT verify failed:", err.message);
            next(new Error("Unauthorized: invalid token"));
        }
    });

    io.on("connection", async (socket) => {
        console.log(`[Socket] Agent connected: ${socket.userId} (${socket.id})`);
        socket.join(`agent:${socket.userId}`);

        // The RFQ attention badge is a global admin/manager count, so those users
        // join a shared room rather than receiving it on their personal channel.
        try {
            const User = require("./models/User");
            const user = await User.findById(socket.userId).select("role").lean();
            if (user && ["admin", "sales_manager"].includes(user.role)) {
                socket.join(RFQ_ATTENTION_ROOM);
            }
        } catch (err) {
            // Non-fatal: the client falls back to its slow poll for this badge.
            console.warn(`[Socket] Could not resolve role for ${socket.userId}:`, err.message);
        }

        socket.on("join_conversation", (phoneNumber) => socket.join(`conv:${phoneNumber}`));
        socket.on("leave_conversation", (phoneNumber) => socket.leave(`conv:${phoneNumber}`));
        socket.on("disconnect", (reason) => console.log(`[Socket] Disconnected: ${socket.userId} — ${reason}`));
    });

    console.log("[Socket] Socket.io initialized");
    return io;
};

const getIO = () => {
    if (!io) throw new Error("Socket.io not initialized");
    return io;
};

const emitNewMessage = (agentId, message) => {
    if (!io) return;
    io.to(`agent:${agentId}`).emit("new_message", message);
    io.to(`conv:${message.conversationId}`).emit("new_message", message);
};

const emitMessageStatus = (agentId, payload) => {
    if (!io) return;
    io.to(`agent:${agentId}`).emit("message_status", payload);
};

const emitToAgent = (agentId, event, data) => {
    if (!io) { console.warn("[Socket] emitToAgent: io not initialized"); return; }
    const room = `agent:${agentId}`;
    const sockets = io.sockets.adapter.rooms.get(room);
    console.log(`[Socket] emitToAgent → room="${room}", event="${event}", sockets=${sockets ? sockets.size : 0}`);
    io.to(room).emit(event, data);
};

/**
 * Push a user's unread-notification count to every tab they have open.
 * Replaces the 30s badge poll the frontend used to run.
 */
const emitUnreadCount = (userId, count) => {
    if (!io || !userId) return;
    io.to(`agent:${userId}`).emit("notification:unread_count", { count });
};

/**
 * Push the global RFQ "needs attention" count to admins and sales managers.
 * Replaces the 15s sidebar badge poll.
 */
const emitRfqAttentionCount = (count) => {
    if (!io) return;
    io.to(RFQ_ATTENTION_ROOM).emit("rfq:attention_count", { count });
};

module.exports = {
    initSocket,
    getIO,
    emitNewMessage,
    emitMessageStatus,
    emitToAgent,
    emitUnreadCount,
    emitRfqAttentionCount,
    RFQ_ATTENTION_ROOM,
};