const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { MongoClient, ObjectId } = require("mongodb");
const multer = require("multer");

const app = express();

const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "PolandShop";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.use(express.static(__dirname));
app.use("/uploads", express.static(uploadsDir));

/* =========================================================
   IMAGE UPLOAD
========================================================= */

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },

  filename: function (req, file, cb) {
    const extension = path.extname(file.originalname).toLowerCase();

    const filename =
      Date.now() +
      "-" +
      crypto.randomBytes(5).toString("hex") +
      extension;

    cb(null, filename);
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 10
  },

  fileFilter: function (req, file, cb) {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif"
    ];

    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only JPG, PNG, WEBP and GIF images are allowed."));
    }

    cb(null, true);
  }
});

/* =========================================================
   DATABASE
========================================================= */

let client = null;
let db = null;

async function connectDatabase() {
  if (!MONGODB_URI) {
    console.error("MONGODB_URI is not configured.");
    return;
  }

  try {
    client = new MongoClient(MONGODB_URI);

    await client.connect();

    db = client.db(DB_NAME);

    await db.collection("products").createIndex({
      createdAt: -1
    });

    await db.collection("orders").createIndex({
      createdAt: -1
    });

    await db.collection("orders").createIndex(
      {
        orderReference: 1
      },
      {
        unique: true
      }
    );

    console.log("MongoDB connected successfully.");
    console.log("Database:", DB_NAME);
  } catch (error) {
    db = null;

    console.error(
      "MongoDB connection error:",
      error.message
    );
  }
}

/* =========================================================
   HELPERS
========================================================= */

function databaseRequired(res) {
  if (!db) {
    res.status(503).json({
      success: false,
      message:
        "Database is not connected. Check MONGODB_URI in Render."
    });

    return false;
  }

  return true;
}

function validObjectId(id) {
  return (
    ObjectId.isValid(id) &&
    String(new ObjectId(id)) === String(id)
  );
}

function cleanText(value, maxLength = 1000) {
  return String(value ?? "")
    .trim()
    .slice(0, maxLength);
}

function getEffectivePrice(product) {
  const price = Number(product.price);

  const discount = Number(
    product.discountPrice
  );

  if (
    Number.isFinite(discount) &&
    discount > 0 &&
    discount < price
  ) {
    return discount;
  }

  return price;
}

function makeOrderReference() {
  const date = new Date();

  const datePart =
    date.getFullYear() +
    String(date.getMonth() + 1).padStart(2, "0") +
    String(date.getDate()).padStart(2, "0");

  const randomPart = crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase();

  return `PS-${datePart}-${randomPart}`;
}

/* =========================================================
   ADMIN AUTHENTICATION
========================================================= */

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      success: false,
      message:
        "ADMIN_TOKEN is not configured on the server."
    });
  }

  const authorization =
    req.headers.authorization || "";

  const token = authorization.startsWith("Bearer ")
    ? authorization.substring(7)
    : "";

  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).json({
      success: false,
      message: "Admin authentication required."
    });
  }

  next();
}

/* =========================================================
   HOME
========================================================= */

app.get("/", function (req, res) {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", function (req, res) {
  res.json({
    success: true,
    message: "PolandShop server is running",
    database: db
      ? "connected"
      : "not connected"
  });
});

/* =========================================================
   PUBLIC PRODUCTS
========================================================= */

app.get("/api/products", async function (req, res) {
  if (!databaseRequired(res)) return;

  try {
    const products = await db
      .collection("products")
      .find({})
      .sort({
        createdAt: -1
      })
      .toArray();

    res.json(products);
  } catch (error) {
    console.error(
      "Products error:",
      error
    );

    res.status(500).json({
      success: false,
      message:
        "Unable to load products."
    });
  }
});

/* =========================================================
   SINGLE PRODUCT
========================================================= */

app.get(
  "/api/products/:id",
  async function (req, res) {
    if (!databaseRequired(res)) return;

    if (!validObjectId(req.params.id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid product ID."
      });
    }

    try {
      const product =
        await db.collection("products").findOne({
          _id: new ObjectId(
            req.params.id
          )
        });

      if (!product) {
        return res.status(404).json({
          success: false,
          message: "Product not found."
        });
      }

      res.json(product);
    } catch (error) {
      console.error(
        "Product error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to load product."
      });
    }
  }
);

/* =========================================================
   ADMIN - CREATE PRODUCT
========================================================= */

app.post(
  "/api/admin/products",
  requireAdmin,
  upload.array("images", 10),
  async function (req, res) {
    if (!databaseRequired(res)) return;

    const uploadedFiles = req.files || [];

    try {
      const name = cleanText(
        req.body.name,
        200
      );

      const description = cleanText(
        req.body.description,
        3000
      );

      const category =
        cleanText(
          req.body.category,
          50
        ) || "Other";

      const price =
        Number(req.body.price);

      const stock =
        Number(req.body.stock);

      const rawDiscount =
        String(
          req.body.discountPrice ?? ""
        ).trim();

      const discountPrice =
        rawDiscount === ""
          ? null
          : Number(rawDiscount);

      const allowedCategories = [
        "Electronics",
        "Home",
        "Fashion",
        "Beauty",
        "Sports",
        "Other"
      ];

      if (!name) {
        return res.status(400).json({
          success: false,
          message:
            "Product name is required."
        });
      }

      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Enter a valid PLN price."
        });
      }

      if (
        !Number.isInteger(stock) ||
        stock < 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Stock must be a whole number of 0 or more."
        });
      }

      if (
        !allowedCategories.includes(
          category
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid product category."
        });
      }

      if (
        discountPrice !== null &&
        (
          !Number.isFinite(
            discountPrice
          ) ||
          discountPrice <= 0 ||
          discountPrice >= price
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Discount price must be below the normal price."
        });
      }

      const product = {
        name,
        description,
        category,

        price: Number(
          price.toFixed(2)
        ),

        discountPrice:
          discountPrice === null
            ? null
            : Number(
                discountPrice.toFixed(2)
              ),

        stock,

        images:
          uploadedFiles.map(
            file =>
              `/uploads/${file.filename}`
          ),

        currency: "PLN",

        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result =
        await db
          .collection("products")
          .insertOne(product);

      product._id =
        result.insertedId;

      res.status(201).json({
        success: true,
        message:
          "Product created successfully.",
        product
      });
    } catch (error) {
      for (const file of uploadedFiles) {
        try {
          fs.unlinkSync(file.path);
        } catch {}
      }

      console.error(
        "Create product error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to create product."
      });
    }
  }
);

/* =========================================================
   ADMIN - GET PRODUCTS
========================================================= */

app.get(
  "/api/admin/products",
  requireAdmin,
  async function (req, res) {
    if (!databaseRequired(res)) return;

    try {
      const products =
        await db
          .collection("products")
          .find({})
          .sort({
            createdAt: -1
          })
          .toArray();

      res.json(products);
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message:
          "Unable to load admin products."
      });
    }
  }
);

/* =========================================================
   ADMIN - DELETE PRODUCT
========================================================= */

app.delete(
  "/api/admin/products/:id",
  requireAdmin,
  async function (req, res) {
    if (!databaseRequired(res)) return;

    if (
      !validObjectId(
        req.params.id
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid product ID."
      });
    }

    try {
      const product =
        await db
          .collection("products")
          .findOne({
            _id: new ObjectId(
              req.params.id
            )
          });

      if (!product) {
        return res.status(404).json({
          success: false,
          message:
            "Product not found."
        });
      }

      await db
        .collection("products")
        .deleteOne({
          _id: product._id
        });

      for (
        const image of
        product.images || []
      ) {
        if (
          image.startsWith(
            "/uploads/"
          )
        ) {
          const filePath =
            path.join(
              __dirname,
              image.replace(
                /^\/+/,
                ""
              )
            );

          try {
            fs.unlinkSync(
              filePath
            );
          } catch {}
        }
      }

      res.json({
        success: true,
        message:
          "Product removed."
      });
    } catch (error) {
      console.error(
        "Delete product error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to remove product."
      });
    }
  }
);

/* =========================================================
   CREATE ORDER
========================================================= */

app.post(
  "/api/orders",
  async function (req, res) {
    if (!databaseRequired(res)) return;

    try {
      const customer =
        req.body.customer || {};

      const incomingItems =
        Array.isArray(req.body.items)
          ? req.body.items
          : [];

      const requiredFields = [
        "fullName",
        "phone",
        "email",
        "country",
        "city",
        "address"
      ];

      for (
        const field of requiredFields
      ) {
        if (
          !cleanText(
            customer[field],
            500
          )
        ) {
          return res.status(400).json({
            success: false,
            message:
              `${field} is required.`
          });
        }
      }

      if (
        incomingItems.length === 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Your cart is empty."
        });
      }

      if (
        incomingItems.length > 50
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Too many items in cart."
        });
      }

      const requested =
        new Map();

      for (
        const item of
        incomingItems
      ) {
        const productId =
          String(
            item.productId ||
            item._id ||
            ""
          );

        const quantity =
          Number(
            item.quantity
          );

        if (
          !validObjectId(
            productId
          ) ||
          !Number.isInteger(
            quantity
          ) ||
          quantity < 1 ||
          quantity > 100
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Invalid cart item."
          });
        }

        requested.set(
          productId,
          (
            requested.get(
              productId
            ) || 0
          ) + quantity
        );
      }

      const productIds =
        [...requested.keys()].map(
          id =>
            new ObjectId(id)
        );

      const products =
        await db
          .collection("products")
          .find({
            _id: {
              $in: productIds
            }
          })
          .toArray();

      const productsById =
        new Map(
          products.map(
            product => [
              String(
                product._id
              ),
              product
            ]
          )
        );

      if (
        products.length !==
        productIds.length
      ) {
        return res.status(400).json({
          success: false,
          message:
            "One or more products are no longer available."
        });
      }

      const orderItems = [];
      let total = 0;

      for (
        const [
          productId,
          quantity
        ] of requested
      ) {
        const product =
          productsById.get(
            productId
          );

        if (
          Number(product.stock) <
          quantity
        ) {
          return res.status(400).json({
            success: false,
            message:
              `${product.name} has only ${product.stock} item(s) available.`
          });
        }

        const unitPrice =
          getEffectivePrice(
            product
          );

        const lineTotal =
          Number(
            (
              unitPrice *
              quantity
            ).toFixed(2)
          );

        total += lineTotal;

        orderItems.push({
          productId:
            product._id,

          name:
            product.name,

          image:
            product.images?.[0] ||
            "",

          unitPrice,

          quantity,

          lineTotal,

          currency: "PLN"
        });
      }

      total =
        Number(
          total.toFixed(2)
        );

      let orderReference =
        makeOrderReference();

      for (
        let i = 0;
        i < 10;
        i++
      ) {
        const exists =
          await db
            .collection("orders")
            .findOne(
              {
                orderReference
              },
              {
                projection: {
                  _id: 1
                }
              }
            );

        if (!exists) break;

        orderReference =
          makeOrderReference();
      }

      const order = {
        orderReference,

        customer: {
          fullName:
            cleanText(
              customer.fullName,
              200
            ),

          phone:
            cleanText(
              customer.phone,
              50
            ),

          email:
            cleanText(
              customer.email,
              200
            ),

          country:
            cleanText(
              customer.country,
              100
            ),

          city:
            cleanText(
              customer.city,
              100
            ),

          address:
            cleanText(
              customer.address,
              500
            ),

          notes:
            cleanText(
              customer.notes,
              1000
            )
        },

        items: orderItems,

        total,

        currency: "PLN",

        paymentMethod:
          "Skrill",

        paymentReference:
          "",

        paymentStatus:
          "pending",

        orderStatus:
          "payment_pending",

        createdAt:
          new Date(),

        updatedAt:
          new Date()
      };

      const result =
        await db
          .collection("orders")
          .insertOne(order);

      order._id =
        result.insertedId;

      res.status(201).json({
        success: true,

        message:
          "Order submitted successfully.",

        orderId:
          orderReference,

        order
      });
    } catch (error) {
      console.error(
        "Order error:",
        error
      );

      res.status(500).json({
        success: false,
        message:
          "Unable to submit order."
      });
    }
  }
);

/* =========================================================
   ADMIN - ORDERS
========================================================= */

app.get(
  "/api/admin/orders",
  requireAdmin,
  async function (req, res) {
    if (!databaseRequired(res)) return;

    try {
      const orders =
        await db
          .collection("orders")
          .find({})
          .sort({
            createdAt: -1
          })
          .toArray();

      res.json(orders);
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message:
          "Unable to load orders."
      });
    }
  }
);

/* =========================================================
   ADMIN - PAYMENT CONFIRMATION
========================================================= */

app.patch(
  "/api/admin/orders/:id/payment",
  requireAdmin,
  async function (req, res) {
    if (!databaseRequired(res)) return;

    if (
      !validObjectId(
        req.params.id
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid order ID."
      });
    }

    const status =
      String(
        req.body.status || ""
      );

    const paymentReference =
      cleanText(
        req.body.paymentReference,
        200
      );

    if (
      !["paid", "rejected"]
        .includes(status)
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid payment status."
      });
    }

    const orders =
      db.collection("orders");

    const products =
      db.collection("products");

    try {
      const order =
        await orders.findOne({
          _id: new ObjectId(
            req.params.id
          )
        });

      if (!order) {
        return res.status(404).json({
          success: false,
          message:
            "Order not found."
        });
      }

      if (
        status === "rejected"
      ) {
        await orders.updateOne(
          {
            _id: order._id
          },
          {
            $set: {
              paymentStatus:
                "rejected",

              orderStatus:
                "payment_rejected",

              paymentReference,

              updatedAt:
                new Date()
            }
          }
        );

        return res.json({
          success: true,
          message:
            "Payment marked as rejected."
        });
      }

      if (
        order.paymentStatus ===
        "paid"
      ) {
        return res.json({
          success: true,
          message:
            "Payment is already marked as paid."
        });
      }

      const session =
        client.startSession();

      try {
        await session.withTransaction(
          async function () {
            for (
              const item of
              order.items
            ) {
              const result =
                await products.updateOne(
                  {
                    _id:
                      new ObjectId(
                        item.productId
                      ),

                    stock: {
                      $gte:
                        item.quantity
                    }
                  },
                  {
                    $inc: {
                      stock:
                        -item.quantity
                    },

                    $set: {
                      updatedAt:
                        new Date()
                    }
                  },
                  {
                    session
                  }
                );

              if (
                result.modifiedCount !==
                1
              ) {
                throw new Error(
                  `Insufficient stock for ${item.name}.`
                );
              }
            }

            await orders.updateOne(
              {
                _id: order._id,

                paymentStatus: {
                  $ne: "paid"
                }
              },
              {
                $set: {
                  paymentStatus:
                    "paid",

                  orderStatus:
                    "processing",

                  paymentReference,

                  updatedAt:
                    new Date()
                }
              },
              {
                session
              }
            );
          }
        );
      } finally {
        await session.endSession();
      }

      res.json({
        success: true,
        message:
          "Payment confirmed and stock updated."
      });
    } catch (error) {
      console.error(
        "Payment confirmation error:",
        error
      );

      res.status(400).json({
        success: false,
        message:
          error.message ||
          "Unable to confirm payment."
      });
    }
  }
);

/* =========================================================
   ADMIN - ORDER STATUS
========================================================= */

app.patch(
  "/api/admin/orders/:id/status",
  requireAdmin,
  async function (req, res) {
    if (!databaseRequired(res)) return;

    if (
      !validObjectId(
        req.params.id
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid order ID."
      });
    }

    const allowedStatuses = [
      "payment_pending",
      "processing",
      "shipped",
      "out_for_delivery",
      "delivered",
      "cancelled",
      "payment_rejected"
    ];

    const status =
      String(
        req.body.status || ""
      );

    if (
      !allowedStatuses.includes(
        status
      )
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Invalid order status."
      });
    }

    try {
      const result =
        await db
          .collection("orders")
          .updateOne(
            {
              _id:
                new ObjectId(
                  req.params.id
                )
            },
            {
              $set: {
                orderStatus:
                  status,

                updatedAt:
                  new Date()
              }
            }
          );

      if (
        !result.matchedCount
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Order not found."
        });
      }

      res.json({
        success: true,
        message:
          "Order status updated."
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message:
          "Unable to update order status."
      });
    }
  }
);

/* =========================================================
   ADMIN UPLOAD TEST
========================================================= */

app.post(
  "/api/admin/upload",
  requireAdmin,
  upload.array("images", 10),
  function (req, res) {
    res.json({
      success: true,

      images:
        (req.files || []).map(
          file =>
            `/uploads/${file.filename}`
        )
    });
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  function (err, req, res, next) {
    console.error(err);

    res.status(400).json({
      success: false,
      message:
        err.message ||
        "Server error."
    });
  }
);

/* =========================================================
   START
========================================================= */

connectDatabase().finally(
  function () {
    app.listen(
      PORT,
      function () {
        console.log(
          `PolandShop server running on port ${PORT}`
        );
      }
    );
  }
);
