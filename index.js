const express = require('express');
const cors = require('cors');
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

const requiredEnvVars = ['MONGO_DB_URI', 'INTERNAL_API_SECRET'];
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

async function run() {
    try {
        await client.connect();
        await client.db('admin').command({ ping: 1 });
        console.log('Successfully connected to MongoDB!');

        const database = client.db('vitaflow');
        const bloodCollection = database.collection('create-donation-request');
        const usersCollection = database.collection('user');

        // ==================== TRUST MIDDLEWARE ====================
        // এই Express server শুধুই আমাদের Next.js server থেকে call accept করে
        // (browser কখনো সরাসরি hit করে না - আমরা confirm করেছি)।
        // x-internal-secret header verify করে নিশ্চিত হই call টা trusted সোর্স থেকে এসেছে।
        const verifyInternalRequest = (req, res, next) => {
            const secret = req.headers['x-internal-secret'];

            if (!secret || secret !== process.env.INTERNAL_API_SECRET) {
                return res.status(401).json({ message: 'Unauthorized: invalid internal request' });
            }
            next();
        };

        // x-user-email / x-user-role header থেকে logged-in user এর তথ্য বের করে req.authUser এ বসায়।
        // Next.js নিজে Better Auth session থেকে এই হেডার দুটো বসায়, তাই এগুলো trusted।
        const attachUser = (req, res, next) => {
            const email = req.headers['x-user-email'] || null;
            const role = req.headers['x-user-role'] || null;
            req.authUser = email ? { email, role } : null;
            next();
        };

        // লগইন করা থাকতেই হবে (email/role header আসতেই হবে), নাহলে 401
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

        // সব রুটে প্রথমে এই দুটো বসিয়ে দিচ্ছি
        app.use(verifyInternalRequest);
        app.use(attachUser);

        app.get('/', (req, res) => {
            res.send('Hello World!');
        });

        // ==================== DONATION REQUEST ENDPOINTS ====================

        // পাবলিক হোমপেজ/donation-list পেজের জন্য - শুধু Pending request, login লাগে না
        // (কিন্তু internal secret তো লাগবেই যেহেতু এটা শুধু Next.js থেকেই hit হয়)
        app.get(
            '/api/public-donation-requests',
            asyncHandler(async (req, res) => {
                const result = await bloodCollection.find({ status: 'Pending' }).toArray();
                res.json(result);
            })
        );

        // সব ডোনেশন রিকোয়েস্ট (ফিল্টার সহ) - শুধু Admin/Volunteer
        app.get(
            '/api/create-donation-request',
            requireAuthUser,
            requireRoleHeader('Admin', 'Volunteer'),
            asyncHandler(async (req, res) => {
                const query = {};
                if (req.query.userId) query.userId = req.query.userId;
                if (req.query.status) query.status = req.query.status;

                const result = await bloodCollection.find(query).toArray();
                res.json(result);
            })
        );

        // নির্দিষ্ট একটা request details - লগইন থাকলেই হবে (Donate Now পেজের জন্য)
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

        // নতুন রিকোয়েস্ট তৈরি - শুধু Donor, এবং active status থাকতে হবে
        app.post(
            '/api/create-donation-request',
            requireAuthUser,
            requireRoleHeader('Donor', 'Admin', 'Volunteer'),
            asyncHandler(async (req, res) => {
                const requester = await usersCollection.findOne({ email: req.authUser.email });

                if (requester?.status === 'Blocked') {
                    return res.status(403).json({ message: 'Blocked users cannot create donation requests' });
                }

                const blood = {
                    ...req.body,
                    requesterEmail: req.authUser.email,
                    status: req.body.status || 'Pending',
                };

                const result = await bloodCollection.insertOne(blood);
                res.status(201).json(result);
            })
        );

        // নিজের রিকোয়েস্ট লিস্ট - শুধু Donor, শুধু নিজের ডাটা
        app.get(
            '/api/my-donation-requests',
            requireAuthUser,
            requireRoleHeader('Donor'),
            asyncHandler(async (req, res) => {
                const email = req.query.email;

                if (!email || email !== req.authUser.email) {
                    return res.status(403).json({ message: 'Forbidden access' });
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

        // রিকোয়েস্ট এডিট - owner (Donor) অথবা Admin/Volunteer
        app.patch(
            '/api/create-donation-request/:id',
            requireAuthUser,
            asyncHandler(async (req, res) => {
                const requestId = toObjectId(req.params.id);
                const existing = await bloodCollection.findOne({ _id: requestId });

                if (!existing) {
                    return res.status(404).json({ message: 'Request not found' });
                }

                const isOwner = existing.requesterEmail === req.authUser.email;
                const isStaff = ['Admin', 'Volunteer'].includes(req.authUser.role);

                if (!isOwner && !isStaff) {
                    return res.status(403).json({ message: 'Forbidden access' });
                }

                const result = await bloodCollection.updateOne(
                    { _id: requestId },
                    { $set: { ...req.body } }
                );

                res.json({ success: true, result });
            })
        );

        // স্ট্যাটাস আপডেট (inprogress -> done/canceled) - owner Donor, অথবা Volunteer (volunteer শুধু status আপডেট করতে পারবে requirement অনুযায়ী)
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

                const isOwner = existing.requesterEmail === req.authUser.email;
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

        // রিকোয়েস্ট ডিলিট - owner (Donor) অথবা Admin
        app.delete(
            '/api/create-donation-request/:id',
            requireAuthUser,
            asyncHandler(async (req, res) => {
                const requestId = toObjectId(req.params.id);
                const existing = await bloodCollection.findOne({ _id: requestId });

                if (!existing) {
                    return res.status(404).json({ message: 'Request not found' });
                }

                const isOwner = existing.requesterEmail === req.authUser.email;
                const isAdmin = req.authUser.role === 'Admin';

                if (!isOwner && !isAdmin) {
                    return res.status(403).json({ message: 'Forbidden access' });
                }

                const result = await bloodCollection.deleteOne({ _id: requestId });
                res.json({ success: true, result });
            })
        );

        // Donate Now কনফার্ম - লগইন করা যেকোনো ইউজার
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
                            donatedAt: new Date(),
                        },
                    }
                );

                res.json({ success: true, message: 'Donation confirmed successfully' });
            })
        );

        

        app.get(
            '/api/all-users',
            requireAuthUser,
            requireRoleHeader('Admin'),
            asyncHandler(async (req, res) => {
                const filter = {};
                if (req.query.status) filter.status = req.query.status;
                const users = await usersCollection.find(filter).toArray();
                res.json(users);
            })
        );

        // ✅ Donor সার্চ - পাবলিক পেজের জন্য, login লাগে না (FIXED with case-insensitive search)
        app.get(
            '/api/search-donors',
            asyncHandler(async (req, res) => {
                const { bloodGroup, district, upazila } = req.query;

                console.log("🔍 [Search Donors] Received query params:", { bloodGroup, district, upazila });

                // ✅ Base query: শুধু Active users, Blocked নয়
                const query = { status: { $ne: 'Blocked' } };

                // ✅ Case-insensitive search with regex
                if (bloodGroup) {
                    query['data.bloodGroup'] = { $regex: bloodGroup, $options: 'i' };
                    console.log("   ✓ Blood group filter applied");
                }
                if (district) {
                    query['data.district'] = { $regex: district, $options: 'i' };
                    console.log("   ✓ District filter applied");
                }
                if (upazila) {
                    query['data.upazila'] = { $regex: upazila, $options: 'i' };
                    console.log("   ✓ Upazila filter applied");
                }

                console.log("📊 [Search Donors] MongoDB query:", JSON.stringify(query, null, 2));

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

                console.log(`✅ [Search Donors] Found ${donors.length} donor(s)`);
                if (donors.length > 0) {
                    console.log("   Sample donor:", JSON.stringify(donors[0], null, 2));
                }

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

        app.put(
            '/api/user/profile',
            requireAuthUser,
            asyncHandler(async (req, res) => {
                const { name, image, data, email } = req.body;

                if (!email || email !== req.authUser.email) {
                    return res.status(403).json({ message: 'Forbidden access' });
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

        // ==================== INTERNAL USER MANAGEMENT ROUTES ====================
        // এই routes গুলো Next.js frontend থেকে call হয়
        // তাই internal secret verify করা হয়েছে middleware এ

        // ✅ Get all users (Admin only) - internal route
        app.get(
            '/api/internal/all-users',
            requireAuthUser,
            requireRoleHeader('Admin'),
            asyncHandler(async (req, res) => {
                const filter = {};
                if (req.query.status) filter.status = req.query.status;
                const users = await usersCollection.find(filter).toArray();
                res.json(users);
            })
        );

        // ✅ Update user status (Admin only) - internal route
        app.patch(
            '/api/internal/user-status/:userId',
            requireAuthUser,
            requireRoleHeader('Admin'),
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

        // ✅ Update user role (Admin only) - internal route
        app.patch(
            '/api/internal/user-role/:userId',
            requireAuthUser,
            requireRoleHeader('Admin'),
            asyncHandler(async (req, res) => {
                const userId = toObjectId(req.params.userId);
                const { role } = req.body;

                const validRoles = ['Donor', 'Volunteer', 'Admin'];
                if (!role || !validRoles.includes(role)) {
                    return res.status(400).json({ message: 'Valid role is required' });
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