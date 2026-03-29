const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "your_secret_key"; // ← must match auth.js exactly

let io = null;

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

    io.on("connection", (socket) => {
        console.log(`[Socket] Agent connected: ${socket.userId} (${socket.id})`);
        socket.join(`agent:${socket.userId}`);

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

module.exports = { initSocket, getIO, emitNewMessage, emitMessageStatus };