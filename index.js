const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken'); // ✅ NEW
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

app.use(
    cors({
        origin: process.env.NEXT_APP_URL || 'http://localhost:3000',
        credentials: true,
    })
);
app.use(express.json());

// ✅ JWT_SECRET যোগ করা হলো required env vars এ
const requiredEnvVars = ['MONGO_DB_URI', 'INTERNAL_API_SECRET', 'JWT_SECRET'];
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
    },
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

const getPagination = (req) => {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.max(parseInt(req.query.limit) || 5, 1);
    const skip = (page - 1) * limit;
    return { page, limit, skip };
};

const escapeRegex = (str) => {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

async function run() {
    try {
        await client.connect();
        await client.db('admin').command({ ping: 1 });
        console.log('Successfully connected to MongoDB!');

        const database = client.db('vitaflow');
        const bloodCollection = database.collection('create-donation-request');
        const usersCollection = database.collection('user');

        // ==================== TRUST MIDDLEWARE ====================
        const verifyInternalRequest = (req, res, next) => {
            const secret = req.headers['x-internal-secret'];
            if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
                return res.status(401).json({ message: 'Unauthorized: invalid internal request' });
            }
            next();
        };

        const verifyJWT = (req, res, next) => {
            const authHeader = req.headers['authorization'];

            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                req.authUser = null;
                return next();
            }

            const token = authHeader.split(' ')[1];

            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                req.authUser = {
                    email: decoded.email,
                    role: decoded.role,
                    userId: decoded.userId,
                    status: decoded.status || 'Active',
                };
            } catch (err) {
                console.error('❌ JWT verification failed:', err.message);
                req.authUser = null;
            }

            next();
        };

        const requireAuthUser = (req, res, next) => {
            if (!req.authUser) {
                return res.status(401).json({ message: 'Unauthorized: login required' });
            }
            next();
        };

        const requireRoleHeader = (...allowedRoles) => (req, res, next) => {
            if (!req.authUser || !allowedRoles.includes(req.authUser.role)) {
                return res.status(403).json({ message: 'Forbidden: insufficient role' });
            }
            next();
        };

        app.use(verifyInternalRequest);
        app.use(verifyJWT);

        app.get('/', (req, res) => {
            res.send('Hello World!');
        });

        // ==================== DONATION REQUEST ENDPOINTS ====================

        app.get(
            '/api/public-donation-requests',
            asyncHandler(async (req, res) => {
                const result = await bloodCollection.find({ status: 'Pending' }).toArray();
                res.json(result);
            })
        );

        app.get(
            '/api/create-donation-request',
            requireAuthUser,
            requireRoleHeader('Admin', 'Volunteer'),
            asyncHandler(async (req, res) => {
                const { page, limit, skip } = getPagination(req);

                const query = {};
                if (req.query.userId) query.userId = req.query.userId;
                if (req.query.status) query.status = req.query.status;

                const [result, total] = await Promise.all([
                    bloodCollection.find(query).skip(skip).limit(limit).toArray(),
                    bloodCollection.countDocuments(query),
                ]);

                res.json({
                    data: result,
                    total,
                    page,
                    totalPages: Math.ceil(total / limit) || 1,
                });
            })
        );

        app.get(
            '/api/create-donation-request/:id',
            requireAuthUser,
            asyncHandler(async (req, res) => {
                const id = toObjectId(req.params.id);
                const result = await bloodCollection.findOne({ _id: id });

                if (!result) {
                    return res.status(404).json({ message: 'Request not found' });
                }
                res.json(result);
            })
        );

        app.post(
            '/api/create-donation-request',
            requireAuthUser,
            requireRoleHeader('Donor', 'Admin', 'Volunteer'),
            asyncHandler(async (req, res) => {
                if (req.authUser.status === 'Blocked') {
                    return res.status(403).json({ message: 'Blocked users cannot create donation requests' });
                }

                const blood = {
                    ...req.body,
                    userId: req.authUser.userId,
                    requesterEmail: req.authUser.email,
                    status: 'Pending',
                };

                const result = await bloodCollection.insertOne(blood);
                res.status(201).json(result);
            })
        );

        app.get(
            '/api/my-donation-requests',
            requireAuthUser,
            requireRoleHeader('Donor'),
            asyncHandler(async (req, res) => {
                const { page, limit, skip } = getPagination(req);
                const filter = { userId: req.authUser.userId };

                if (req.query.status) {
                    filter.status = req.query.status;
                }

                const [donations, total] = await Promise.all([
                    bloodCollection.find(filter).skip(skip).limit(limit).toArray(),
                    bloodCollection.countDocuments(filter),
                ]);

                res.json({
                    data: donations,
                    total,
                    page,
                    totalPages: Math.ceil(total / limit) || 1,
                });
            })
        );

        app.patch(
            '/api/create-donation-request/:id',
            requireAuthUser,
            asyncHandler(async (req, res) => {
                const requestId = toObjectId(req.params.id);
                const existing = await bloodCollection.findOne({ _id: requestId });

                if (!existing) {
                    return res.status(404).json({ message: 'Request not found' });
                }

                const isOwner = existing.userId === req.authUser.userId;
                const isAdmin = req.authUser.role === 'Admin';

                if (!isOwner && !isAdmin) {
                    return res.status(403).json({ message: 'Forbidden access' });
                }

                const result = await bloodCollection.updateOne(
                    { _id: requestId },
                    { $set: { ...req.body } }
                );

                res.json({ success: true, result });
            })
        );

        app.patch(
            '/api/create-donation-request/status/:id',
            requireAuthUser,
            asyncHandler(async (req, res) => {
                const requestId = toObjectId(req.params.id);
                const { status } = req.body;

                const validStatuses = ['pending', 'inprogress', 'done', 'canceled'];
                if (!status || !validStatuses.includes(status.toLowerCase())) {
                    return res.status(400).json({ message: 'Invalid status value' });
                }

                const existing = await bloodCollection.findOne({ _id: requestId });
                if (!existing) {
                    return res.status(404).json({ message: 'Request not found' });
                }

                const isOwner = existing.userId === req.authUser.userId;
                const isAdmin = req.authUser.role === 'Admin';
                const isVolunteer = req.authUser.role === 'Volunteer';

                if (!isOwner && !isAdmin && !isVolunteer) {
                    return res.status(403).json({ message: 'Forbidden access' });
                }

                const result = await bloodCollection.updateOne(
                    { _id: requestId },
                    { $set: { status } }
                );

                res.json({ success: true, message: 'Status updated successfully' });
            })
        );

        app.delete(
            '/api/create-donation-request/:id',
            requireAuthUser,
            asyncHandler(async (req, res) => {
                const requestId = toObjectId(req.params.id);
                const existing = await bloodCollection.findOne({ _id: requestId });

                if (!existing) {
                    return res.status(404).json({ message: 'Request not found' });
                }

                const isOwner = existing.userId === req.authUser.userId;
                const isAdmin = req.authUser.role === 'Admin';

                if (!isOwner && !isAdmin) {
                    return res.status(403).json({ message: 'Forbidden access' });
                }

                const result = await bloodCollection.deleteOne({ _id: requestId });
                res.json({ success: true, result });
            })
        );

        app.patch(
            '/api/create-donation-request/donate/:id',
            requireAuthUser,
            asyncHandler(async (req, res) => {
                const requestId = toObjectId(req.params.id);
                const { donorName, donorEmail } = req.body;

                if (!donorName || !donorEmail || donorEmail !== req.authUser.email) {
                    return res.status(400).json({ message: 'Valid donor name and email are required' });
                }

                const existing = await bloodCollection.findOne({ _id: requestId });
                if (!existing) {
                    return res.status(404).json({ message: 'Request not found' });
                }

                if (existing.status === 'In Progress') {
                    return res.status(409).json({ message: 'This request is already in progress' });
                }

                const result = await bloodCollection.updateOne(
                    { _id: requestId },
                    {
                        $set: {
                            status: 'In Progress',
                            donorName,
                            donorEmail,
                            donorUserId: req.authUser.userId,
                            donatedAt: new Date(),
                        },
                    }
                );

                res.json({ success: true, message: 'Donation confirmed successfully' });
            })
        );

        // ==================== USER MANAGEMENT (ADMIN ONLY) ====================

        app.get(
            '/api/all-users',
            requireAuthUser,
            requireRoleHeader('Admin'),
            asyncHandler(async (req, res) => {
                const { page, limit, skip } = getPagination(req);

                const filter = {};
                if (req.query.status) {
                    filter.status = req.query.status;
                }

                const [users, total] = await Promise.all([
                    usersCollection.find(filter).skip(skip).limit(limit).toArray(),
                    usersCollection.countDocuments(filter),
                ]);

                res.json({
                    data: users,
                    total,
                    page,
                    totalPages: Math.ceil(total / limit) || 1,
                });
            })
        );

        app.get(
            '/api/search-donors',
            asyncHandler(async (req, res) => {
                const { bloodGroup, district, upazila } = req.query;
                const query = { status: { $ne: 'Blocked' } };

                if (bloodGroup) query['data.bloodGroup'] = { $regex: escapeRegex(bloodGroup), $options: 'i' };
                if (district) query['data.district'] = { $regex: escapeRegex(district), $options: 'i' };
                if (upazila) query['data.upazila'] = { $regex: escapeRegex(upazila), $options: 'i' };

                const donors = await usersCollection
                    .find(query)
                    .project({
                        name: 1,
                        email: 1,
                        image: 1,
                        role: 1,
                        status: 1,
                        'data.bloodGroup': 1,
                        'data.district': 1,
                        'data.upazila': 1,
                    })
                    .toArray();

                res.json(donors);
            })
        );

        app.patch(
            '/api/all-users/status/:userId',
            requireAuthUser,
            requireRoleHeader('Admin'),
            asyncHandler(async (req, res) => {
                const userId = toObjectId(req.params.userId);
                const { status } = req.body;

                if (!status) {
                    return res.status(400).json({ message: 'Status is required' });
                }

                const result = await usersCollection.updateOne({ _id: userId }, { $set: { status } });

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: 'User not found' });
                }

                res.json({ success: true, message: 'Status updated successfully' });
            })
        );

        app.patch(
            '/api/all-users/role/:userId',
            requireAuthUser,
            requireRoleHeader('Admin'),
            asyncHandler(async (req, res) => {
                const userId = toObjectId(req.params.userId);
                const { role } = req.body;

                const validRoles = ['Donor', 'Volunteer', 'Admin'];
                if (!role || !validRoles.includes(role)) {
                    return res.status(400).json({ message: 'Valid role is required' });
                }

                const result = await usersCollection.updateOne({ _id: userId }, { $set: { role } });

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: 'User not found' });
                }

                res.json({ success: true, message: 'Role updated successfully' });
            })
        );

        // ==================== PROFILE ENDPOINTS ====================

        app.get(
            '/api/profile',
            requireAuthUser,
            asyncHandler(async (req, res) => {
                const email = req.query.email;

                if (!email || email !== req.authUser.email) {
                    return res.status(403).json({ message: 'Forbidden access' });
                }

                const user = await usersCollection.findOne({ email });
                if (!user) {
                    return res.status(404).json({ message: 'User not found' });
                }

                res.json(user);
            })
        );

        app.put(
            '/api/profile',
            requireAuthUser,
            asyncHandler(async (req, res) => {
                const { email, name, image, data } = req.body;

                if (!email || email !== req.authUser.email) {
                    return res.status(403).json({ message: 'Forbidden access' });
                }

                const result = await usersCollection.updateOne({ email }, { $set: { name, image, data } });

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: 'User not found' });
                }

                res.json({ success: true, message: 'Profile updated successfully' });
            })
        );


        // এই দুইটা route তোমার server.js এ replace করো

        // ✅ GET /api/fundings — সবার জন্য (authentication ছাড়াই দেখা যাবে)
        app.get(
            '/api/fundings',
            asyncHandler(async (req, res) => {
                const fundingsCollection = database.collection('fundings');
                const fundings = await fundingsCollection
                    .find({})
                    .sort({ createdAt: -1 })
                    .toArray();
                res.json(fundings);
            })
        );

        // ✅ POST /api/fundings — শুধু logged-in user save করতে পারবে
        app.post(
            '/api/fundings',
            requireAuthUser,
            asyncHandler(async (req, res) => {
                const { amount, donorName, transactionId } = req.body;

                if (!amount || amount < 1) {
                    return res.status(400).json({ message: 'Valid amount is required' });
                }

                if (!transactionId) {
                    return res.status(400).json({ message: 'Transaction ID is required' });
                }

                const fundingsCollection = database.collection('fundings');

                const funding = {
                    // ✅ client থেকে আসা donorName সেভ করো
                    donorName: donorName?.trim() || req.authUser.email,
                    amount: parseFloat(amount),
                    transactionId,
                    userEmail: req.authUser.email,  // reference রাখো
                    createdAt: new Date(),
                };

                const result = await fundingsCollection.insertOne(funding);
                res.status(201).json(result);
            })
        );

        // ✅ POST /api/create-payment-intent — Stripe payment intent তৈরি করো
        app.post(
            '/api/create-payment-intent',
            requireAuthUser,
            asyncHandler(async (req, res) => {
                const { amount } = req.body;

                if (!amount || amount < 1) {
                    return res.status(400).json({ message: 'Valid amount is required' });
                }

                if (!process.env.STRIPE_SECRET_KEY) {
                    return res.status(500).json({ message: 'Stripe secret key not configured' });
                }

                // ✅ Stripe instance একবার তৈরি করো
                const Stripe = require('stripe');
                const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

                const paymentIntent = await stripe.paymentIntents.create({
                    amount: Math.round(parseFloat(amount) * 100), // cents এ convert
                    currency: 'usd',
                    metadata: {
                        userId: req.authUser.userId || 'unknown',
                        userEmail: req.authUser.email,
                    },
                });

                res.json({ clientSecret: paymentIntent.client_secret });
            })
        );

        // ==================== STATS (ADMIN/VOLUNTEER DASHBOARD) ====================

        app.get(
            '/api/stats',
            requireAuthUser,
            requireRoleHeader('Admin', 'Volunteer'),
            asyncHandler(async (req, res) => {
                const totalUsers = await usersCollection.countDocuments({ role: 'Donor' });
                const totalRequests = await bloodCollection.countDocuments({});
                res.json({ totalUsers, totalRequests, totalFunding: 0 });
            })
        );

        // ==================== 404 + ERROR HANDLER ====================
        app.use((req, res) => {
            res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
        });

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