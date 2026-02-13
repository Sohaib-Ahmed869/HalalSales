const CryptoJS = require("crypto-js");
// Comprehensive Decryption Attempt Script
const encryptedData = "/auDUsBOIMdCNvLAS89VNGO11GwJn8nVg+Ht5e7imEA/4YXxz5scJUMKCDQ7HbYKo/1Cm6QGFDNX0gS3b8JKLuFqe7iDCpNTvTJk0stJJ8GeC1157sSjVzexm0PiofDuAGwAnCg21LUQ/dFOZ1fvznTmnwg9LOg+JSub/e03ulwoExquczok1zG+Sk3aE94oscW28alzbPgYwUclvSEOcw99k3tg7/7uYJ/6gjDlOrpNxjWe/aS1YKOX4hbSLiTgrR20TJUafq9QjqRLqDFUfN/L1zeXckONhFbWBcR56EC7cI4AbECgJ22Vxt4JPVIFNpCK/n1EvFkJd0ld7wFik3VE8C5WpPWZChvDwAGrD0ok0v89bcr0KoR4vABsR/Vxyb6Ryy9PXtzeyo+vVu9rC9Mb9X464YQX0u9L1tEMgdsjwAYmEs7FmKPmCw3/My1jdxe9juT5qWa43DXYZVC4gg==";

// Common passwords to try
const commonPasswords = [
    "",
    "password",
    "123456",
    "admin",
    "secret",
    "test",
    "default",
    "encryption",
    "key",
    "mypassword"
];

// All encryption algorithms available in CryptoJS
const algorithms = [
    { name: 'AES', algo: CryptoJS.AES },
    { name: 'DES', algo: CryptoJS.DES },
    { name: 'TripleDES', algo: CryptoJS.TripleDES },
    { name: 'RC4', algo: CryptoJS.RC4 },
    { name: 'RC4Drop', algo: CryptoJS.RC4Drop },
    { name: 'Rabbit', algo: CryptoJS.Rabbit },
    { name: 'RabbitLegacy', algo: CryptoJS.RabbitLegacy }
];

// All cipher modes
const modes = [
    { name: 'CBC', mode: CryptoJS.mode.CBC },
    { name: 'CFB', mode: CryptoJS.mode.CFB },
    { name: 'CTR', mode: CryptoJS.mode.CTR },
    { name: 'OFB', mode: CryptoJS.mode.OFB },
    { name: 'ECB', mode: CryptoJS.mode.ECB }
];

// All padding schemes
const paddings = [
    { name: 'Pkcs7', pad: CryptoJS.pad.Pkcs7 },
    { name: 'Iso97971', pad: CryptoJS.pad.Iso97971 },
    { name: 'AnsiX923', pad: CryptoJS.pad.AnsiX923 },
    { name: 'Iso10126', pad: CryptoJS.pad.Iso10126 },
    { name: 'ZeroPadding', pad: CryptoJS.pad.ZeroPadding },
    { name: 'NoPadding', pad: CryptoJS.pad.NoPadding }
];

console.log("🔍 Starting comprehensive decryption attempts...\n");

// Method 1: Try all algorithms with common passwords
function tryAllAlgorithmsWithPasswords() {
    console.log("📋 Method 1: Testing all algorithms with common passwords");

    algorithms.forEach(alg => {
        commonPasswords.forEach(password => {
            try {
                const decrypted = alg.algo.decrypt(encryptedData, password);
                const plaintext = decrypted.toString(CryptoJS.enc.Utf8);

                if (plaintext && plaintext.length > 0) {
                    console.log(`✅ SUCCESS with ${alg.name} + password: "${password}"`);
                    console.log(`   Decrypted: ${plaintext}`);
                    return;
                }
            } catch (e) {
                // Silent fail
            }
        });
    });
}

// Method 2: Try with different modes and paddings
function tryAllModesAndPaddings() {
    console.log("\n📋 Method 2: Testing AES with all mode/padding combinations");

    const testPasswords = ["password", "secret", ""];

    testPasswords.forEach(password => {
        modes.forEach(mode => {
            paddings.forEach(padding => {
                try {
                    const decrypted = CryptoJS.AES.decrypt(
                        encryptedData,
                        password,
                        {
                            mode: mode.mode,
                            padding: padding.pad
                        }
                    );
                    const plaintext = decrypted.toString(CryptoJS.enc.Utf8);

                    if (plaintext && plaintext.length > 0) {
                        console.log(`✅ SUCCESS: ${mode.name} + ${padding.name} + password: "${password}"`);
                        console.log(`   Decrypted: ${plaintext}`);
                        return;
                    }
                } catch (e) {
                    // Silent fail
                }
            });
        });
    });
}

// Method 3: Analyze the encrypted data structure
function analyzeEncryptedData() {
    console.log("\n📋 Method 3: Analyzing encrypted data structure");

    try {
        const bytes = CryptoJS.enc.Base64.parse(encryptedData);
        console.log(`   Total bytes: ${bytes.sigBytes}`);
        console.log(`   First 32 bytes (hex): ${bytes.toString(CryptoJS.enc.Hex).substring(0, 64)}`);

        // Check for "Salted__" header (OpenSSL format)
        const words = bytes.words;
        const headerBytes = [
            (words[0] >> 24) & 0xFF,
            (words[0] >> 16) & 0xFF,
            (words[0] >> 8) & 0xFF,
            words[0] & 0xFF,
            (words[1] >> 24) & 0xFF,
            (words[1] >> 16) & 0xFF,
            (words[1] >> 8) & 0xFF,
            words[1] & 0xFF
        ];

        const header = String.fromCharCode(...headerBytes);
        console.log(`   Header (first 8 bytes): "${header}"`);

        if (header === 'Salted__') {
            console.log(`   ✅ OpenSSL format detected!`);
            const saltWords = [words[2], words[3]];
            const salt = CryptoJS.lib.WordArray.create(saltWords, 8);
            console.log(`   Salt (hex): ${salt.toString(CryptoJS.enc.Hex)}`);
        } else {
            console.log(`   ℹ️  Not standard OpenSSL format`);
        }

        // Check if it's a multiple of block size
        console.log(`   Is multiple of 16 bytes (AES): ${bytes.sigBytes % 16 === 0}`);
        console.log(`   Is multiple of 8 bytes (DES): ${bytes.sigBytes % 8 === 0}`);

    } catch (e) {
        console.log(`   ❌ Error analyzing: ${e.message}`);
    }
}

// Method 4: Try raw Base64 decode
function tryRawDecode() {
    console.log("\n📋 Method 4: Raw Base64 decode analysis");

    try {
        const decoded = CryptoJS.enc.Base64.parse(encryptedData);
        const hex = decoded.toString(CryptoJS.enc.Hex);
        const latin1 = decoded.toString(CryptoJS.enc.Latin1);

        console.log(`   Hex (first 100 chars): ${hex.substring(0, 100)}...`);
        console.log(`   Latin1 (first 50 chars): ${latin1.substring(0, 50).replace(/[^\x20-\x7E]/g, '.')}...`);

        // Look for patterns
        if (hex.match(/^(00|ff)+/)) {
            console.log(`   ⚠️  Starts with padding bytes`);
        }

    } catch (e) {
        console.log(`   ❌ Error: ${e.message}`);
    }
}

// Method 5: Try with derived keys using PBKDF2
function tryWithDerivedKeys() {
    console.log("\n📋 Method 5: Testing with PBKDF2-derived keys");

    const testPasswords = ["password", "secret", "admin"];
    const iterations = [1000, 10000, 100000];

    testPasswords.forEach(password => {
        iterations.forEach(iter => {
            try {
                // Common salts to try
                const salts = [
                    CryptoJS.lib.WordArray.random(128 / 8),
                    CryptoJS.enc.Hex.parse('0000000000000000'),
                    CryptoJS.enc.Utf8.parse('salt')
                ];

                salts.forEach(salt => {
                    const key = CryptoJS.PBKDF2(password, salt, {
                        keySize: 256 / 32,
                        iterations: iter
                    });

                    const decrypted = CryptoJS.AES.decrypt(
                        encryptedData,
                        key,
                        { iv: salt.clone() }
                    );

                    const plaintext = decrypted.toString(CryptoJS.enc.Utf8);
                    if (plaintext && plaintext.length > 0) {
                        console.log(`✅ SUCCESS with PBKDF2: password="${password}", iterations=${iter}`);
                        console.log(`   Decrypted: ${plaintext}`);
                    }
                });
            } catch (e) {
                // Silent fail
            }
        });
    });
}

// Method 6: Check for JSON structure after partial decrypt
function checkForJsonStructure() {
    console.log("\n📋 Method 6: Checking for JSON patterns");

    const bytes = CryptoJS.enc.Base64.parse(encryptedData);
    const hex = bytes.toString(CryptoJS.enc.Hex);

    // Look for common JSON patterns in hex
    const jsonPatterns = [
        '7b',    // {
        '5b',    // [
        '22',    // "
        '7d',    // }
        '5d'     // ]
    ];

    jsonPatterns.forEach(pattern => {
        const count = (hex.match(new RegExp(pattern, 'g')) || []).length;
        console.log(`   Pattern '${pattern}' appears ${count} times`);
    });
}

// Run all methods
tryAllAlgorithmsWithPasswords();
tryAllModesAndPaddings();
analyzeEncryptedData();
tryRawDecode();
tryWithDerivedKeys();
checkForJsonStructure();

console.log("\n🏁 Decryption attempts completed");