const express = require("express");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const path = require("path");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
require('dotenv').config(); // Load environment variables

const Razorpay = require("razorpay");

const app = express();
const PORT = process.env.PORT || 5000;
const SECRET_KEY = process.env.SECRET_KEY;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID, 
  key_secret: process.env.RAZORPAY_KEY_SECRET, 
});

// Add this route to your server.js file
app.get("/get-razorpay-key", authenticateToken, (req, res) => {
  res.json({ key: process.env.RAZORPAY_KEY_ID });
});



// Middleware to authenticate routes
function authenticateToken(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// Routes

// Fetch all products
app.get("/products", async (req, res) => {
  const { gender, size, color, sort } = req.query;
  let query = supabase.from("products").select("*");

  // Apply filters if they exist
  if (gender) query = query.eq("gender", gender);
  if (size) query = query.eq("size", size);
  if (color) query = query.eq("color", color);

  // Apply sorting if it exists
  if (sort) {
    const [field, order] = sort.split(":");
    query = query.order(field, { ascending: order === "asc" });
  }

  // Execute the query
  const { data: products, error } = await query;

  if (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch products" });
  }

  res.json(products);
});

// Fetch a single product by ID
app.get("/product/:id", async (req, res) => {
  const productId = req.params.id;

  const { data: product, error } = await supabase
    .from("products")
    .select("*")
    .eq("id", productId)
    .single();

  if (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch product" });
  }

  // Combine all image URLs into an array, filtering out null values
  const images = [product.image_url, product.image_url2, product.image_url3].filter(url => url);

  // Add the images array to the product object
  product.images = images;

  res.json(product);
});

// Fetch reviews for a product
app.get("/product/:id/reviews", async (req, res) => {
  const productId = req.params.id;

  const { data: reviews, error } = await supabase
    .from("reviews")
    .select("*, users(full_name)")
    .eq("product_id", productId);

  if (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch reviews" });
  }

  res.json(reviews);
});

// Add a review for a product
app.post("/product/:id/reviews", authenticateToken, async (req, res) => {
  const productId = req.params.id;
  const { text, rating } = req.body;

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("email", req.user.email)
    .single();

  if (userError) {
    return res.status(500).json({ success: false, message: "Failed to fetch user" });
  }

  const { data: review, error: insertError } = await supabase
    .from("reviews")
    .insert([{ product_id: productId, user_id: user.id, text, rating }]);

  if (insertError) {
    return res.status(500).json({ success: false, message: "Failed to add review" });
  }

  res.json({ success: true, message: "Review added successfully" });
});

// Add a product to the cart
app.post("/cart", authenticateToken, async (req, res) => {
  const { productId, quantity, size, color } = req.body;

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("email", req.user.email)
    .single();

  if (userError) {
    return res.status(500).json({ success: false, message: "Failed to fetch user" });
  }

  // Check if the product already exists in the cart
  const { data: existingCartItem, error: existingError } = await supabase
    .from("cart")
    .select("*")
    .eq("user_id", user.id)
    .eq("product_id", productId)
    .eq("size", size)
    .eq("color", color)
    .single();

  if (existingError && existingError.code !== "PGRST116") {
    return res.status(500).json({ success: false, message: "Failed to check existing cart item" });
  }

  if (existingCartItem) {
    // Update quantity if the product already exists in the cart
    const { error: updateError } = await supabase
      .from("cart")
      .update({ quantity: existingCartItem.quantity + quantity })
      .eq("id", existingCartItem.id);

    if (updateError) {
      return res.status(500).json({ success: false, message: "Failed to update cart item" });
    }

    return res.json({ success: true, message: "Cart item updated" });
  } else {
    // Insert new item if the product does not exist in the cart
    const { data: cartItem, error: insertError } = await supabase
      .from("cart")
      .insert([{ user_id: user.id, product_id: productId, quantity, size, color }])
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({ success: false, message: "Failed to add to cart" });
    }

    return res.json({ success: true, message: "Item added to cart", data: cartItem });
  }
});

// Fetch cart items for the logged-in user
app.get("/cart", authenticateToken, async (req, res) => {
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("email", req.user.email)
    .single();

  if (userError) {
    return res.status(500).json({ success: false, message: "Failed to fetch user" });
  }

  const { data: cartItems, error } = await supabase
    .from("cart")
    .select("*, products(*)")
    .eq("user_id", user.id);

  if (error) {
    return res.status(500).json({ success: false, message: "Failed to fetch cart items" });
  }

  res.json(cartItems);
});

// Remove an item from the cart
app.delete("/cart/:id", authenticateToken, async (req, res) => {
  const cartId = req.params.id;

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("email", req.user.email)
    .single();

  if (userError) {
    return res.status(500).json({ success: false, message: "Failed to fetch user" });
  }

  const { error } = await supabase
    .from("cart")
    .delete()
    .eq("id", cartId)
    .eq("user_id", user.id);

  if (error) {
    return res.status(500).json({ success: false, message: "Failed to remove from cart" });
  }

  res.json({ success: true, message: "Item removed from cart" });
});


// User signup
app.post("/signup", async (req, res) => {
  const { fullName, mobile, email, password } = req.body;

  if (!fullName || !mobile || !email || !password) {
    return res.status(400).json({ success: false, message: "All fields are required" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const { data: existingUser, error: userError } = await supabase
    .from("users")
    .select("*")
    .eq("email", email);

  if (userError) {
    return res.status(500).json({ success: false, message: "Database error" });
  }

  if (existingUser.length > 0) {
    return res.status(400).json({ success: false, message: "Email already exists" });
  }

  const { data: newUser, error: insertError } = await supabase
    .from("users")
    .insert([{ full_name: fullName, mobile, email, password: hashedPassword }])
    .select()
    .single();

  if (insertError) {
    return res.status(500).json({ success: false, message: "Failed to create user" });
  }

  const token = jwt.sign({ email }, SECRET_KEY, { expiresIn: "1h" });
  res.json({ success: true, token });
});


// User login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const { data: user, error } = await supabase
    .from("users")
    .select("*")
    .eq("email", email)
    .single();

  if (error || !user || !(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ success: false, message: "Invalid credentials" });
  }

  const token = jwt.sign({ email }, SECRET_KEY, { expiresIn: "1h" });
  res.json({ success: true, token });
});

// Checkout and create an order
app.post("/checkout", authenticateToken, async (req, res) => {
  const { name, phone, address, pinCode, state, cartItems } = req.body;

  if (!name || !phone || !address || !pinCode || !state || !cartItems || cartItems.length === 0) {
    return res.status(400).json({ success: false, message: "Incomplete order details" });
  }

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("email", req.user.email)
    .single();

  if (userError) {
    return res.status(500).json({ success: false, message: "Failed to fetch user" });
  }

  // Create order
  const { data: order, error: orderError } = await supabase
    .from("orders")
    .insert([{ 
      user_id: user.id, 
      name, 
      phone, 
      address, 
      pin_code: pinCode, 
      state 
    }])
    .select()
    .single();

  if (orderError) {
    return res.status(500).json({ success: false, message: "Failed to create order" });
  }

  // Add order items
  const orderItems = cartItems.map((item) => ({
    order_id: order.id,
    product_id: item.product_id,
    quantity: item.quantity,
    size: item.size,
    color: item.color,
    price: item.products.price, // Use the price from the product details
  }));

  const { error: itemsError } = await supabase.from("order_items").insert(orderItems);

  if (itemsError) {
    return res.status(500).json({ success: false, message: "Failed to add order items" });
  }

  // Clear the cart
  const { error: cartError } = await supabase.from("cart").delete().eq("user_id", user.id);

  if (cartError) {
    return res.status(500).json({ success: false, message: "Failed to clear cart" });
  }

  res.json({ success: true, message: "Order placed successfully", orderId: order.id });
});
// Fetch order history for the logged-in user
app.get("/orders", authenticateToken, async (req, res) => {
  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("email", req.user.email)
    .single();

  if (userError) {
    return res.status(500).json({ success: false, message: "Failed to fetch user" });
  }

  const { data: orders, error: ordersError } = await supabase
    .from("orders")
    .select("*, order_items(*, products(*))")
    .eq("user_id", user.id);

  if (ordersError) {
    return res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }

  res.json(orders);
});

// Create a Razorpay order
app.post("/create-razorpay-order", authenticateToken, async (req, res) => {
  const { amount } = req.body;

  const options = {
    amount: amount * 100, // amount in the smallest currency unit (paise for INR)
    currency: "INR",
    receipt: "order_rcptid_11",
  };

  try {
    const response = await razorpay.orders.create(options);
    res.json({ success: true, order: response });
  } catch (error) {
    console.error('Razorpay error:', error);
    res.status(500).json({ success: false, message: "Failed to create Razorpay order" });
  }
});



// wishlist 
// Fetch user's wishlist
// Fetch user's wishlist
app.get("/wishlist", authenticateToken, async (req, res) => {
  try {
    console.log("Fetching wishlist for user:", req.user.email);

    // Fetch user ID
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id")
      .eq("email", req.user.email)
      .single();

    if (userError) {
      console.error("Error fetching user:", userError);
      return res.status(500).json({ success: false, message: "Failed to fetch user" });
    }

    // Fetch wishlist items
    const { data: wishlistItems, error: wishlistError } = await supabase
      .from("wishlist")
      .select("*, products(*)")
      .eq("user_id", user.id);

    if (wishlistError) {
      console.error("Error fetching wishlist items:", wishlistError);
      return res.status(500).json({ success: false, message: "Failed to fetch wishlist items" });
    }

    console.log("Wishlist items fetched successfully:", wishlistItems);
    res.json(wishlistItems);
  } catch (err) {
    console.error("Unexpected error in /wishlist:", err);
    res.status(500).json({ success: false, message: "Unexpected error occurred" });
  }
});
// Add a product to the wishlist
app.post("/wishlist", authenticateToken, async (req, res) => {
  const { productId } = req.body;

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("email", req.user.email)
    .single();

  if (userError) {
    return res.status(500).json({ success: false, message: "Failed to fetch user" });
  }

  // Check if the product already exists in the wishlist
  const { data: existingWishlistItem, error: existingError } = await supabase
    .from("wishlist")
    .select("*")
    .eq("user_id", user.id)
    .eq("product_id", productId)
    .single();

  if (existingError && existingError.code !== "PGRST116") {
    return res.status(500).json({ success: false, message: "Failed to check existing wishlist item" });
  }

  if (existingWishlistItem) {
    return res.status(400).json({ success: false, message: "Product already in wishlist" });
  } 

  // Insert new item if the product does not exist in the wishlist
  const { data: wishlistItem, error: insertError } = await supabase
    .from("wishlist")
    .insert([{ user_id: user.id, product_id: productId }])
    .select()
    .single();

  if (insertError) {
    return res.status(500).json({ success: false, message: "Failed to add to wishlist" });
  }

  return res.json({ success: true, message: "Item added to wishlist", data: wishlistItem });
});

// Remove a product from the wishlist
app.delete("/wishlist/:id", authenticateToken, async (req, res) => {
  const productId = req.params.id;

  const { data: user, error: userError } = await supabase
    .from("users")
    .select("id")
    .eq("email", req.user.email)
    .single();

  if (userError) {
    return res.status(500).json({ success: false, message: "Failed to fetch user" });
  }

  const { error } = await supabase
    .from("wishlist")
    .delete()
    .eq("product_id", productId)
    .eq("user_id", user.id);

  if (error) {
    return res.status(500).json({ success: false, message: "Failed to remove from wishlist" });
  }

  res.json({ success: true, message: "Item removed from wishlist" });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

