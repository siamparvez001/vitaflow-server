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

// ✅ Regex special characters escape করার জন্য
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

        // ✅ userId resolve করে req.authUser এ বসাবো
        const attachUser = asyncHandler(async (req, res, next) => {
            const email = req.headers['x-user-email'] || null;
            const role = req.headers['x-user-role'] || null;

            if (!email) {
                req.authUser = null;
                return next();
            }

            const dbUser = await usersCollection.findOne({ email });
            req.authUser = {
                email,
                role,
                userId: dbUser?._id?.toString() || null,
                status: dbUser?.status || 'Active',
            };
            next();
        });

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
        app.use(attachUser);

        app.get('/', (req, res) => {
            res.send('Hello World!');
        });

        // ==================== DONATION REQUEST ENDPOINTS ====================

        // পাবলিক - শুধু Pending request, login লাগে না
        app.get(
            '/api/public-donation-requests',
            asyncHandler(async (req, res) => {
                const result = await bloodCollection.find({ status: 'Pending' }).toArray();
                res.json(result);
            })
        );

        // সব ডোনেশন রিকোয়েস্ট (ফিল্টার সহ) - Admin/Volunteer
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

        // একটা request এর details - লগইন থাকলেই হবে
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

        // নতুন রিকোয়েস্ট তৈরি - শুধু Donor
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

        // নিজের রিকোয়েস্ট লিস্ট - userId দিয়ে, শুধু Donor
        app.get(
            '/api/my-donation-requests',
            requireAuthUser,
            requireRoleHeader('Donor'),
            asyncHandler(async (req, res) => {
                const donations = await bloodCollection
                    .find({ userId: req.authUser.userId })
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

                const isOwner = existing.userId === req.authUser.userId;
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

        // স্ট্যাটাস আপডেট - owner (Donor), Admin, অথবা Volunteer
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

                const isOwner = existing.userId === req.authUser.userId;
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
                const filter = {};
                if (req.query.status) filter.status = req.query.status;
                const users = await usersCollection.find(filter).toArray();
                res.json(users);
            })
        );

        // ✅ Donor সার্চ - FIXED with escapeRegex
        app.get(
            '/api/search-donors',
            asyncHandler(async (req, res) => {
                const { bloodGroup, district, upazila } = req.query;

                console.log("🔍 [Search Donors] Received query:", { bloodGroup, district, upazila });

                const query = { status: { $ne: 'Blocked' } };

                if (bloodGroup) {
                    const escaped = escapeRegex(bloodGroup);
                    query['data.bloodGroup'] = { $regex: escaped, $options: 'i' };
                    console.log(`   ✓ Blood Group filter: ${escaped}`);
                }
                if (district) {
                    const escaped = escapeRegex(district);
                    query['data.district'] = { $regex: escaped, $options: 'i' };
                    console.log(`   ✓ District filter: ${escaped}`);
                }
                if (upazila) {
                    const escaped = escapeRegex(upazila);
                    query['data.upazila'] = { $regex: escaped, $options: 'i' };
                    console.log(`   ✓ Upazila filter: ${escaped}`);
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
                    console.log("Sample donor:", JSON.stringify(donors[0], null, 2));
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
        // Admin only - internal routes

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