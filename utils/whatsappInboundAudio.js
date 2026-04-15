const os = require("os");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Convert inbound OGG/Opus (or other audio) to MP3 for universal browser playback.
 * Same pipeline as WhatsApp Cloud API inbound media in whatsapp.controller.js.
 */
function convertInboundAudioToMp3(inputBuffer) {
    return new Promise((resolve, reject) => {
        const tmpIn = path.join(os.tmpdir(), `wa-inbound-${uuidv4()}`);
        const tmpOut = path.join(os.tmpdir(), `wa-inbound-${uuidv4()}.mp3`);
        try {
            fs.writeFileSync(tmpIn, inputBuffer);
        } catch (err) {
            return reject(err);
        }

        ffmpeg(tmpIn)
            .audioCodec("libmp3lame")
            .audioChannels(1)
            .audioFrequency(44100)
            .audioBitrate("64k")
            .format("mp3")
            .on("error", (err) => {
                try {
                    fs.unlinkSync(tmpIn);
                } catch (_) {}
                try {
                    fs.unlinkSync(tmpOut);
                } catch (_) {}
                reject(err);
            })
            .on("end", () => {
                try {
                    const outBuffer = fs.readFileSync(tmpOut);
                    resolve(outBuffer);
                } catch (err) {
                    reject(err);
                } finally {
                    try {
                        fs.unlinkSync(tmpIn);
                    } catch (_) {}
                    try {
                        fs.unlinkSync(tmpOut);
                    } catch (_) {}
                }
            })
            .save(tmpOut);
    });
}

module.exports = { convertInboundAudioToMp3 };
