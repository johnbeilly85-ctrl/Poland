const express = require("express");
const path = require("path");
const fs = require("fs");
const { MongoClient, ObjectId } = require("mongodb");
const multer = require("multer");

const app = express();
const PORT = process.env.PORT || 10000;

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "PolandShop";

// ==========================================
// DIRECTORIES
// ==========================================

const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.use(express.static(__dirname));

app.use("/uploads", express.static(uploadsDir));

// ==========================================
// IMAGE UPLOAD
// ==========================================

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },

  filename: function (req, file, cb) {
    const extension = path.extname(file.originalname);

    const filename =
      Date.now() +
      "-" +
      Math.random().toString(36).substring(2, 10) +
      extension;

    cb(null, filename);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024
  },
  fileFilter: function (req, file, cb) {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif"
    ];

    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed."));
    }
  }
});

// ==========================================
// MONGODB
// ==========================================

let db = null;

async function connectDatabase() {
  if (!MONGODB_URI) {
    console.log("MONGODB_URI is not configured.");
    console.log("Server will run without database connection.");
    return;
  }

  try {
    const client = new MongoClient(MONGODB_URI);

    await client.connect();

    db = client.db(DB_NAME);

    console.log("MongoDB connected successfully.");
    console.log(`Database: ${DB_NAME}`);
  } catch (error) {
    console.error("MongoDB connection error:", error.message);
  }
}

// ==========================================
// HOME
// ==========================================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "PolandShop server is running",
    database: db ? "connected" : "not connected"
  });
});

// ==========================================
// PRODUCTS
// ==========================================

app.get("/api/products", async (req, res) => {
  try {
    if (!db) {
      return res.json([]);
    }

    const products = await db
      .collection("products")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json(products);
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to load products."
    });
  }
});

// ==========================================
// SINGLE PRODUCT
// ==========================================

app.get("/api/products/:id", async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected."
      });
    }

    const product = await db.collection("products").findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found."
      });
    }

    res.json(product);
  } catch (error) {
    res.status(400).json({
      success: false,
      message: "Invalid product ID."
    });
  }
});

// ==========================================
// ADMIN PRODUCT CREATION
// ==========================================

app.post("/api/admin/products", upload.array("images", 10), async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected."
      });
    }

    const {
      name,
      description,
      category,
      price,
      discountPrice,
      stock
    } = req.body;

    if (!name || !price) {
      return res.status(400).json({
        success: false,
        message: "Product name and price are required."
      });
    }

    const images = (req.files || []).map(file => {
      return "/uploads/" + file.filename;
    });

    const product = {
      name: name.trim(),
      description: description || "",
      category: category || "Other",
      price: Number(price),
      discountPrice:
        discountPrice && discountPrice !== ""
          ? Number(discountPrice)
          : null,
      stock: Number(stock || 0),
      images,
      currency: "PLN",
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db
      .collection("products")
      .insertOne(product);

    res.json({
      success: true,
      message: "Product created successfully.",
      productId: result.insertedId
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to create product."
    });
  }
});

// ==========================================
// ORDERS
// ==========================================

app.post("/api/orders", async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected."
      });
    }

    const {
      customer,
      items,
      total,
      paymentMethod,
      paymentReference
    } = req.body;

    if (!customer || !items || !items.length) {
      return res.status(400).json({
        success: false,
        message: "Customer information and cart items are required."
      });
    }

    const order = {
      customer,
      items,
      total: Number(total || 0),
      currency: "PLN",

      paymentMethod: paymentMethod || "Skrill Manual",
      paymentReference: paymentReference || "",

      paymentStatus: "verification_required",
      orderStatus: "payment_pending",

      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db
      .collection("orders")
      .insertOne(order);

    res.json({
      success: true,
      message: "Order submitted successfully.",
      orderId: result.insertedId
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to submit order."
    });
  }
});

// ==========================================
// ADMIN ORDERS
// ==========================================

app.get("/api/admin/orders", async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected."
      });
    }

    const orders = await db
      .collection("orders")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.json(orders);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to load orders."
    });
  }
});

// ==========================================
// ADMIN PAYMENT CONFIRMATION
// ==========================================

app.patch("/api/admin/orders/:id/payment", async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected."
      });
    }

    const { status } = req.body;

    if (!["paid", "rejected"].includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment status."
      });
    }

    const update = {
      paymentStatus: status,
      updatedAt: new Date()
    };

    if (status === "paid") {
      update.orderStatus = "processing";
    }

    if (status === "rejected") {
      update.orderStatus = "payment_rejected";
    }

    const result = await db
      .collection("orders")
      .updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: update }
      );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    res.json({
      success: true,
      message: `Payment marked as ${status}.`
    });

  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message: "Unable to update payment."
    });
  }
});

// ==========================================
// ADMIN DELIVERY STATUS
// ==========================================

app.patch("/api/admin/orders/:id/status", async (req, res) => {
  try {
    if (!db) {
      return res.status(503).json({
        success: false,
        message: "Database is not connected."
      });
    }

    const allowedStatuses = [
      "payment_pending",
      "processing",
      "shipped",
      "out_for_delivery",
      "delivered",
      "cancelled"
    ];

    const { status } = req.body;

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        message: "Invalid order status."
      });
    }

    const result = await db
      .collection("orders")
      .updateOne(
        { _id: new ObjectId(req.params.id) },
        {
          $set: {
            orderStatus: status,
            updatedAt: new Date()
          }
        }
      );

    if (!result.matchedCount) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    res.json({
      success: true,
      message: "Order status updated."
    });

  } catch (error) {
    console.error(error);

    res.status(400).json({
      success: false,
      message: "Unable to update order status."
    });
  }
});

// ==========================================
// UPLOAD TEST
// ==========================================

app.post("/api/admin/upload", upload.array("images", 10), (req, res) => {
  const images = (req.files || []).map(file => {
    return "/uploads/" + file.filename;
  });

  res.json({
    success: true,
    images
  });
});

// ==========================================
// ERROR HANDLER
// ==========================================

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    success: false,
    message: err.message || "Server error."
  });
});

// ==========================================
// START SERVER
// ==========================================

connectDatabase().finally(() => {
  app.listen(PORT, () => {
    console.log(`PolandShop server running on port ${PORT}`);
  });
});
