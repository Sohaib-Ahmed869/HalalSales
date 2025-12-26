// test-smtp.js
require('dotenv').config();
const nodemailer = require('nodemailer');

async function testSMTP() {
    console.log('\n=== SMTP Configuration Test ===\n');

    const port = parseInt(process.env.EMAIL_PORT);
    const secure = port === 465; // true for 465, false for 587

    console.log('Configuration:');
    console.log(`  Host: ${process.env.EMAIL_HOST}`);
    console.log(`  Port: ${port}`);
    console.log(`  Secure: ${secure}`);
    console.log(`  User: ${process.env.EMAIL_USER}`);
    console.log(`  Password: ${process.env.EMAIL_PASSWORD ? '***' + process.env.EMAIL_PASSWORD.slice(-4) : 'NOT SET'}`);
    console.log('');

    const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: port,
        secure: secure, // true for 465, false for other ports
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD,
        },
        // Add timeouts
        connectionTimeout: 10000,
        greetingTimeout: 5000,
        socketTimeout: 10000,
        debug: true,
        logger: true,
    });

    try {
        console.log('Testing connection (timeout: 10s)...');
        const verifyPromise = transporter.verify();
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timeout after 10 seconds')), 10000)
        );

        await Promise.race([verifyPromise, timeoutPromise]);
        console.log('✅ Connection successful!\n');

        console.log('Sending test email...');
        const info = await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: 'sohaibsipra111@gmail.com',
            subject: 'SMTP Test - ' + new Date().toISOString(),
            text: 'If you receive this, SMTP is working correctly!',
        });

        console.log('✅ Test email sent:', info.messageId);

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error('   Code:', error.code);
        console.error('   Command:', error.command);

        // Suggest alternatives
        console.log('\n💡 Troubleshooting suggestions:');
        if (error.message.includes('timeout')) {
            console.log('   1. Try port 587 instead of 465');
            console.log('   2. Check if your firewall is blocking SMTP');
            console.log('   3. Verify you can ping ssl0.ovh.net');
        }

    } finally {
        transporter.close();
        console.log('\n=== Test Complete ===\n');
    }
}

testSMTP();