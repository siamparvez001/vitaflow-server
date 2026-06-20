const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const requiredEnvVars = ['MONGO_DB_URI'];
const missingEnvVars = requiredEnvVars.filter((key) => !process.env[key]);

if (missingEnvVars.length > 0) {
    console.error(` Missing required environment variable(s): ${missingEnvVars.join(', ')}`);
    process.exit(1);
}

const uri = process.env.MONGO_DB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

const toObjectId = (id) => {
    if (!ObjectId.isValid(id)) {
        const err = new Error('Invalid ID format');
        err.statusCode = 400;
        throw err;
    }
    return new ObjectId(id);
};

async function run() {
    try {
        await client.connect();
        await client.db('admin').command({ ping: 1 });
        console.log('Successfully connected to MongoDB!');

        const database = client.db('vitaflow');
        const bloodCollection = database.collection('create-donation-request');
        const usersCollection = database.collection('user');

        app.get('/', (req, res) => {
            res.send('Hello World!');
        });

        // ১. সব ডোনেশন রিকোয়েস্ট (ফিল্টার সহ)
        app.get(
            '/api/create-donation-request',
            asyncHandler(async (req, res) => {
                const query = {};
                if (req.query.userId) {
                    query.userId = req.query.userId;
                }
                if (req.query.status) {
                    query.status = req.query.status;
                }
                const result = await bloodCollection.find(query).toArray();
                res.json(result);
            })
        );

        // ২. নতুন ডোনেশন রিকোয়েস্ট তৈরি করা (POST)
        // ✅ status পাঠানো না হলেও default "Pending" সেট হবে
        app.post(
            '/api/create-donation-request',
            asyncHandler(async (req, res) => {
                const blood = {
                    ...req.body,
                    status: req.body.status || 'Pending',
                };
                console.log('Received:', blood);

                const result = await bloodCollection.insertOne(blood);
                res.status(201).json(result);
            })
        );

        // ৩. আমার ডোনেশন রিকোয়েস্ট (email দিয়ে)
        app.get(
            '/api/my-donation-requests',
            asyncHandler(async (req, res) => {
                const email = req.query.email;

                if (!email) {
                    return res.status(400).json({ message: 'Email is required' });
                }

                const user = await usersCollection.findOne({ email });

                if (!user) {
                    return res.status(404).json({ message: 'User not found' });
                }

                const donations = await bloodCollection
                    .find({ userId: user._id.toString() })
                    .toArray();

                res.json(donations);
            })
        );

        // ৩.৫ ✅ নতুন: Donate Now কনফার্ম করা (donor info সেভ + status আপডেট)
        app.patch(
            '/api/create-donation-request/donate/:id',
            asyncHandler(async (req, res) => {
                const requestId = toObjectId(req.params.id);
                const { donorName, donorEmail } = req.body;

                if (!donorName || !donorEmail) {
                    return res
                        .status(400)
                        .json({ message: 'Donor name and email are required' });
                }

                // ইতিমধ্যে কেউ donate confirm করে ফেলেছে কিনা চেক করা
                // (একই request এ দুইজন একসাথে donate চাপলে race condition এড়াতে)
                const existing = await bloodCollection.findOne({ _id: requestId });

                if (!existing) {
                    return res.status(404).json({ message: 'Request not found' });
                }

                if (existing.status === 'In Progress') {
                    return res
                        .status(409)
                        .json({ message: 'This request is already in progress' });
                }

                const result = await bloodCollection.updateOne(
                    { _id: requestId },
                    {
                        $set: {
                            status: 'In Progress',
                            donorName,
                            donorEmail,
                            donatedAt: new Date(),
                        },
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: 'Request not found' });
                }

                res.json({ success: true, message: 'Donation confirmed successfully' });
            })
        );

        // ==================== USER MANAGEMENT ENDPOINTS ====================

        // ৪. সব ইউজার লিস্ট (All Users Page এর জন্য)
        app.get(
            '/api/all-users',
            asyncHandler(async (req, res) => {
                const users = await usersCollection.find({}).toArray();
                res.json(users);
            })
        );

        // ৪.৫ ✅ নতুন: Donor সার্চ (public Search page এর জন্য)
        // blood group, district, upazila — যেগুলো পাঠানো হবে শুধু সেগুলো দিয়েই filter হবে
        app.get(
            '/api/search-donors',
            asyncHandler(async (req, res) => {
                const { bloodGroup, district, upazila } = req.query;

                const query = {
                    // blocked user দের donor list এ দেখানো হবে না
                    status: { $ne: 'Blocked' },
                };

                if (bloodGroup) query['data.bloodGroup'] = bloodGroup;
                if (district) query['data.district'] = district;
                if (upazila) query['data.upazila'] = upazila;

                const donors = await usersCollection
                    .find(query)
                    .project({
                        name: 1,
                        email: 1,
                        image: 1,
                        role: 1,
                        'data.bloodGroup': 1,
                        'data.district': 1,
                        'data.upazila': 1,
                    })
                    .toArray();

                res.json(donors);
            })
        );

        // ৫. ইউজার স্ট্যাটাস আপডেট (Block/Unblock)
        app.patch(
            '/api/all-users/status/:userId',
            asyncHandler(async (req, res) => {
                const userId = toObjectId(req.params.userId);
                const { status } = req.body;

                if (!status) {
                    return res.status(400).json({ message: 'Status is required' });
                }

                const result = await usersCollection.updateOne(
                    { _id: userId },
                    { $set: { status } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: 'User not found' });
                }

                res.json({ success: true, message: 'Status updated successfully' });
            })
        );

        // ৬. ইউজার রোল আপডেট (Admin/Volunteer)
        app.patch(
            '/api/all-users/role/:userId',
            asyncHandler(async (req, res) => {
                const userId = toObjectId(req.params.userId);
                const { role } = req.body;

                if (!role) {
                    return res.status(400).json({ message: 'Role is required' });
                }

                const result = await usersCollection.updateOne(
                    { _id: userId },
                    { $set: { role } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: 'User not found' });
                }

                res.json({ success: true, message: 'Role updated successfully' });
            })
        );

        // ==================== PROFILE ENDPOINTS ====================

        // ৭. প্রোফাইল ডাটা ফেচ করা (email দিয়ে)
        app.get(
            '/api/profile',
            asyncHandler(async (req, res) => {
                const email = req.query.email;
                if (!email) {
                    return res.status(400).json({ message: 'Email is required' });
                }

                const user = await usersCollection.findOne({ email });

                if (!user) {
                    return res.status(404).json({ message: 'User not found' });
                }

                res.json(user);
            })
        );

        // ৮. প্রোফাইল আপডেট করা (PUT)
        app.put(
            '/api/profile',
            asyncHandler(async (req, res) => {
                const { email, name, image, data } = req.body;

                if (!email) {
                    return res.status(400).json({ message: 'Email is required' });
                }

                const result = await usersCollection.updateOne(
                    { email },
                    { $set: { name, image, data } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: 'User not found' });
                }

                res.json({ success: true, message: 'Profile updated successfully' });
            })
        );

        // ৯. ইউজার প্রোফাইল সম্পূর্ণ আপডেট করা
        app.put(
            '/api/user/profile',
            asyncHandler(async (req, res) => {
                const { name, image, data, email } = req.body;

                if (!email) {
                    return res
                        .status(400)
                        .json({ message: 'User email is required to update profile' });
                }

                if (!data) {
                    return res.status(400).json({ message: 'Profile data is required' });
                }

                const result = await usersCollection.updateOne(
                    { email },
                    {
                        $set: {
                            name,
                            image,
                            data: {
                                bloodGroup: data.bloodGroup,
                                district: data.district,
                                upazila: data.upazila,
                                title: data.title,
                                donorStatus: data.donorStatus,
                                visibility: data.visibility,
                            },
                        },
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: 'User not found to update' });
                }

                res.json({ success: true, message: 'Profile updated successfully', result });
            })
        );

        // ==================== 404 HANDLER ====================
        app.use((req, res) => {
            res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
        });

        // ==================== GLOBAL ERROR HANDLER ====================
        app.use((err, req, res, next) => {
            console.error('Server Error:', err);
            res.status(err.statusCode || 500).json({
                message: err.message || 'Internal Server Error',
            });
        });

        app.listen(port, () => {
            console.log(`Server listening on port ${port}`);
        });
    } catch (error) {
        console.error('MongoDB Connection Error:', error);
        process.exit(1);
    }
}

run();

process.on('SIGINT', async () => {
    console.log('\nShutting down server...');
    await client.close();
    process.exit(0);
});