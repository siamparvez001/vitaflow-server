const express = require('express');
const cors = require('cors')
const app = express();
const port = 5000;
require('dotenv').config();
app.use(cors());
app.use(express.json());

const { MongoClient, ServerApiVersion } = require('mongodb');
app.get('/', (req, res) => {
    res.send('Hello World!');
});

const uri = process.env.MONGO_DB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const database = client.db("vitaflow")
        const bloodCollection = database.collection("create-donation-request")
         const usersCollection = database.collection("user");
        const sessionCollection = database.collection("session")

        app.get('/api/create-donation-request', async (req, res) => {
            const query = {}
            if (req.query.userId) {
                query.userId = req.query.userId
            }
            if (req.query.status) {
                query.status = req.query.status
            }
            const cursor = bloodCollection.find(query)
            const result = await cursor.toArray();
            res.send(result);
        })


        app.post('/api/create-donation-request', async (req, res) => {
            try {
                const blood = req.body;

                console.log("Received:", blood);

                const result = await bloodCollection.insertOne(blood);

                res.status(201).json(result);
            } catch (error) {
                console.error("Route Error:", error);

                res.status(500).json({
                    message: error.message,
                });
            }
        });


        // আপনার ব্যাকএন্ডে (Express.js) এই কোডটুকু যোগ করুন

        // ১. লগইন থাকা সিঙ্গেল ইউজারের প্রোফাইল ডাটা ডাটাবেজ থেকে খোঁজা
        app.get('/api/profile', async (req, res) => {
            try {
                const email = req.query.email;
                if (!email) {
                    return res.status(400).json({ message: "Email is required" });
                }

                // আপনার বেটার-অথ বা ইউজার কালেকশন থেকে ইমেইল অনুযায়ী ইউজার খোঁজা
                // (যদি কালেকশনের নাম 'user' এর বদলে অন্য কিছু হয়, তবে সেটা দিবেন, যেমন 'users')
                const usersCollection = database.collection("user");

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

        // ২. প্রোফাইল আপডেট বা সেভ করার রাউট (PUT Request)
        app.put('/api/profile', async (req, res) => {
            try {
                const body = req.body;
                // এখানে আপনার ডাটাবেজের ইউজার আপডেট করার লজিক হবে
                // যেমন: const result = await usersCollection.updateOne({ email: ... }, { $set: ... })

                res.json({ success: true, message: "Profile updated successfully" });
            } catch (error) {
                res.status(500).json({ message: error.message });
            }
        });

        // আপনার এক্সপ্রেস (Express) ব্যাকএন্ডে এই কোডটি বসিয়ে দিন

        app.put('/api/user/profile', async (req, res) => {
            try {
                const { name, image, data, email } = req.body;

                // এখানে আপনার ফ্রন্টএন্ড ফর্ম থেকে পাঠানো ইউজারের ইমেইলটি লাগবে
                // যদি ফ্রন্টএন্ড বডিতে ইমেইল না থাকে, তবে কোয়েরি প্যারামিটার বা সেশন থেকেও নিতে পারেন
                if (!email) {
                    return res.status(400).json({ message: "User email is required to update profile" });
                }

                const usersCollection = database.collection("user");

                // ডাটাবেজে ইমেইল অনুযায়ী ইউজারকে খুঁজে তার ফিল্ডগুলো আপডেট করা
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



        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } catch (error) {
        console.error("MongoDB Connection Error:", error);
    }

}
run().catch(console.dir);





app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});