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
        const sessionCollection = database.collection("session")

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

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    }catch (error) {
        console.error("MongoDB Connection Error:", error);
    }
    //  finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    // }
}
run().catch(console.dir);





app.listen(port, () => {
    console.log(`Example app listening on port ${port}`);
});