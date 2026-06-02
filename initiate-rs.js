const { MongoClient } = require('mongodb');

async function main() {
  const client = new MongoClient('mongodb://127.0.0.1:27018/?directConnection=true');
  try {
    await client.connect();
    console.log('Connected to MongoDB at 127.0.0.1:27018');
    const adminDb = client.db('admin');
    
    // Check if already in replica set
    try {
      const status = await adminDb.command({ replSetGetStatus: 1 });
      if (status && status.ok) {
        console.log('Replica set is already initialized:', status.set);
        return;
      }
    } catch (e) {
      // replSetGetStatus throws if not initialized
    }
    
    console.log('Initiating replica set...');
    await adminDb.command({
      replSetInitiate: {
        _id: 'rs0',
        members: [{ _id: 0, host: '127.0.0.1:27018' }]
      }
    });
    console.log('Replica set initiated successfully!');
  } catch (err) {
    console.error('Error initiating replica set:', err);
  } finally {
    await client.close();
  }
}

main();
