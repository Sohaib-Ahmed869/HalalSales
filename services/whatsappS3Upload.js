const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const resolveRegion = () => {
    const r =
        process.env.AWS_REGION ||
        process.env.AWS_REGION_LAMBDA ||
        process.env.AWS_DEFAULT_REGION ||
        "eu-north-1";
    return r && r !== "undefined" ? r : "eu-north-1";
};

const region = resolveRegion();

/** Align with `S3_BUCKET` / default used elsewhere when `AWS_S3_BUCKET` is unset (e.g. production). */
function resolveWhatsAppS3Bucket() {
    const b =
        process.env.AWS_S3_BUCKET ||
        process.env.S3_BUCKET ||
        "halalfoodattachments";
    const t = typeof b === "string" ? b.trim() : "";
    return t || "halalfoodattachments";
}

const s3 = new S3Client({
    region,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY,
    },
});

/**
 * Build a virtual-hosted–style public object URL with each key segment URL-encoded
 * (+, spaces, unicode in filenames / phone folders resolve correctly in browsers).
 */
function buildPublicS3ObjectUrl(bucket, regionName, key) {
    const encodedPath = String(key)
        .split("/")
        .filter((seg) => seg.length > 0)
        .map((seg) => encodeURIComponent(seg))
        .join("/");
    return `https://${bucket}.s3.${regionName}.amazonaws.com/${encodedPath}`;
}

/** Prefer no ACL (block public ACLs / bucket owner enforced); retry with public-read if AWS suggests ACL path. */
async function putObjectNoAclFirst(paramsBase) {
    try {
        await s3.send(new PutObjectCommand(paramsBase));
        console.log(`[WhatsAppImport S3] Upload OK (no ACL): ${paramsBase.Key}`);
    } catch (err) {
        const name = err.name || "";
        const msg = String(err.message || err);
        const retryWithAcl =
            name === "AccessDenied" ||
            /ACL|AccessControlList|AclNotSupported|Cannot use ACL|InvalidAccessControlList/i.test(msg);
        if (retryWithAcl) {
            await s3.send(new PutObjectCommand({ ...paramsBase, ACL: "public-read" }));
            console.log(`[WhatsAppImport S3] Upload OK (with ACL): ${paramsBase.Key}`);
        } else {
            throw err;
        }
    }
}

/**
 * Upload a buffer to S3 with a caller-controlled key (e.g. whatsapp-imports/...).
 * Returns a correctly encoded public URL.
 */
async function uploadBufferWithKey({ key, buffer, contentType }) {
    const bucket = resolveWhatsAppS3Bucket();
    await putObjectNoAclFirst({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType || "application/octet-stream",
    });
    return buildPublicS3ObjectUrl(bucket, region, key);
}

module.exports = {
    uploadBufferWithKey,
    buildPublicS3ObjectUrl,
    s3Region: region,
    resolveWhatsAppS3Bucket,
};
