const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = 5000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Hello World!');
});

const uri = process.env.MONGO_DB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        await client.connect();

        const database = client.db("vitaflow");
        const bloodCollection = database.collection("create-donation-request");
        const usersCollection = database.collection("user");
        const sessionCollection = database.collection("session");

        // ==================== DONATION REQUEST ENDPOINTS ====================

        // ১. সব ডোনেশন রিকোয়েস্ট (ফিল্টার সহ)
        app.get('/api/create-donation-request', async (req, res) => {
            try {
                const query = {};
                if (req.query.userId) {
                    query.userId = req.query.userId;
                }
                if (req.query.status) {
                    query.status = req.query.status;
                }
                const result = await bloodCollection.find(query).toArray();
                res.json(result);
            } catch (error) {
                console.error("Error:", error);
                res.status(500).json({ message: error.message });
            }
        });

        // ২. নতুন ডোনেশন রিকোয়েস্ট তৈরি করা (POST)
        app.post('/api/create-donation-request', async (req, res) => {
            try {
                const blood = req.body;
                console.log("Received:", blood);

                const result = await bloodCollection.insertOne(blood);
                res.status(201).json(result);
            } catch (error) {
                console.error("Route Error:", error);
                res.status(500).json({ message: error.message });
            }
        });

        // ৩. আমার ডোনেশন রিকোয়েস্ট (email দিয়ে)
        app.get('/api/my-donation-requests', async (req, res) => {
            try {
                const email = req.query.email;

                if (!email) {
                    return res.status(400).json({ message: "Email is required" });
                }

                // ইউজার খুঁজো email দিয়ে
                const user = await usersCollection.findOne({ email: email });

                if (!user) {
                    return res.status(404).json({ message: "User not found" });
                }

                // সেই ইউজারের donation requests খুঁজো
                const donations = await bloodCollection.find({
                    userId: user._id.toString()
                }).toArray();

                res.json(donations);
            } catch (error) {
                console.error("Error fetching donations:", error);
                res.status(500).json({ message: error.message });
            }
        });

        // ==================== USER MANAGEMENT ENDPOINTS ====================

        // ৪. সব ইউজার লিস্ট (All Users Page এর জন্য)
        app.get('/api/all-users', async (req, res) => {
            try {
                const users = await usersCollection.find({}).toArray();
                res.json(users);
            } catch (error) {
                console.error("Error fetching users:", error);
                res.status(500).json({ message: error.message });
            }
        });

        // ৫. ইউজার স্ট্যাটাস আপডেট (Block/Unblock)
        app.patch('/api/all-users/status/:userId', async (req, res) => {
            try {
                const userId = req.params.userId;
                const { status } = req.body;

                const result = await usersCollection.updateOne(
                    { _id: new ObjectId(userId) },
                    { $set: { status: status } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: "User not found" });
                }

                res.json({ success: true, message: "Status updated successfully" });
            } catch (error) {
                console.error("Error:", error);
                res.status(500).json({ message: error.message });
            }
        });

        // ৬. ইউজার রোল আপডেট (Admin/Volunteer)
        app.patch('/api/all-users/role/:userId', async (req, res) => {
            try {
                const userId = req.params.userId;
                const { role } = req.body;

                const result = await usersCollection.updateOne(
                    { _id: new ObjectId(userId) },
                    { $set: { role: role } }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: "User not found" });
                }

                res.json({ success: true, message: "Role updated successfully" });
            } catch (error) {
                console.error("Error:", error);
                res.status(500).json({ message: error.message });
            }
        });

        // ==================== PROFILE ENDPOINTS ====================

        // ৭. প্রোফাইল ডাটা ফেচ করা (email দিয়ে)
        app.get('/api/profile', async (req, res) => {
            try {
                const email = req.query.email;
                if (!email) {
                    return res.status(400).json({ message: "Email is required" });
                }

                const user = await usersCollection.findOne({ email: email });

                if (!user) {
                    return res.status(404).json({ message: "User not found" });
                }

                res.json(user);
            } catch (error) {
                console.error("Backend Error:", error);
                res.status(500).json({ message: "Internal Server Error" });
            }
        });

        // ৮. প্রোফাইল আপডেট করা (PUT)
        app.put('/api/profile', async (req, res) => {
            try {
                const { email, name, image, data } = req.body;

                if (!email) {
                    return res.status(400).json({ message: "Email is required" });
                }

                const result = await usersCollection.updateOne(
                    { email: email },
                    {
                        $set: {
                            name: name,
                            image: image,
                            data: data
                        }
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: "User not found" });
                }

                res.json({ success: true, message: "Profile updated successfully" });
            } catch (error) {
                console.error("Update Error:", error);
                res.status(500).json({ message: error.message });
            }
        });

        // ৯. ইউজার প্রোফাইল সম্পূর্ণ আপডেট করা
        app.put('/api/user/profile', async (req, res) => {
            try {
                const { name, image, data, email } = req.body;

                if (!email) {
                    return res.status(400).json({ message: "User email is required to update profile" });
                }

                const result = await usersCollection.updateOne(
                    { email: email },
                    {
                        $set: {
                            name: name,
                            image: image,
                            data: {
                                bloodGroup: data.bloodGroup,
                                district: data.district,
                                upazila: data.upazila,
                                title: data.title,
                                donorStatus: data.donorStatus,
                                visibility: data.visibility
                            }
                        }
                    }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ message: "User not found to update" });
                }

                res.json({ success: true, message: "Profile updated successfully", result });
            } catch (error) {
                console.error("Update Error:", error);
                res.status(500).json({ message: error.message });
            }
        });

        // Database connection verify
        await client.db("admin").command({ ping: 1 });
        console.log("✅ Successfully connected to MongoDB!");

    } catch (error) {
        console.error("❌ MongoDB Connection Error:", error);
    }
}

run().catch(console.dir);

app.listen(port, () => {
    console.log(`🚀 Server listening on port ${port}`);
});