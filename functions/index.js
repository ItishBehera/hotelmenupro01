// functions/index.js (Gen2 + params)
const admin = require("firebase-admin");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const { Resend } = require("resend");


// Gen2 HTTPS callable + Errors
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");

// Params (new system)
const { defineSecret, defineString } = require("firebase-functions/params");
const cookie = require("cookie");

admin.initializeApp();
const db = admin.firestore();

// ✅ Region
const REGION = "asia-south1";

// ✅ Store Key ID as normal param (not secret) OR as secret.
// Key ID is not sensitive, Secret is sensitive.
const RAZORPAY_KEY_ID = defineString("RAZORPAY_KEY_ID");
const RAZORPAY_KEY_SECRET = defineSecret("RAZORPAY_KEY_SECRET");
const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const EMAIL_FROM = "HotelMenuPro <noreply@hotelmenupro.com>";
const SUPPORT_EMAIL = "hotelmenupro@gmail.com";
const APP_BASE_URL = "https://hotelmenupro.com";

// ✅ Price map (paise)
const PLANS = {
  starter_monthly: 2999 * 100,
  starter_yearly: 28000 * 100,
  pro_monthly: 4999 * 100,
  pro_yearly: 51000 * 100,
};
function addPlanDuration(startDate, planKey) {
const result = new Date(startDate);

if (String(planKey).endsWith("_monthly")) {
result.setMonth(result.getMonth() + 1);
}

if (String(planKey).endsWith("_yearly")) {
result.setFullYear(result.getFullYear() + 1);
}

return result;
}
function parseFirestoreDate(value) {
  if (!value) return null;

  if (value.toDate && typeof value.toDate === "function") {
    const d = value.toDate();
    return d instanceof Date && !isNaN(d.getTime()) ? d : null;
  }

  if (value instanceof Date) {
    return !isNaN(value.getTime()) ? value : null;
  }

  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return !isNaN(d.getTime()) ? d : null;
  }

  return null;
}
async function activateUpcomingPlanForHotel(hotelDoc) {
  // ✅ Always re-read the latest hotel doc from Firestore
  const freshHotelSnap = await hotelDoc.ref.get();
  if (!freshHotelSnap.exists) {
    return { activated: false, deactivated: false };
  }

  const hotelId = freshHotelSnap.id;
  const hotelData = freshHotelSnap.data() || {};
  const now = new Date();

  const currentValidTill = parseFirestoreDate(hotelData.validTill);

  // if current plan is still active, do nothing
  if (currentValidTill && currentValidTill.getTime() > now.getTime()) {
    return { activated: false, deactivated: false };
  }

  // find the next paid upcoming order whose start time has already arrived
  const upcomingSnap = await db
    .collection("subscriptionOrders")
    .where("hotelSlug", "==", hotelId)
    .where("status", "==", "paid")
    .where("isUpcoming", "==", true)
    .orderBy("planStartDate", "asc")
    .limit(1)
    .get();

  // no upcoming plan -> deactivate expired subscription
  if (upcomingSnap.empty) {
    const batch = db.batch();

    batch.set(
      freshHotelSnap.ref,
      {
        subscriptionActive: false,
        upcomingPlanKey: admin.firestore.FieldValue.delete(),
        upcomingPlanStartDate: admin.firestore.FieldValue.delete(),
        upcomingPlanValidTill: admin.firestore.FieldValue.delete(),
      },
      { merge: true }
    );

    if (hotelData.ownerUid) {
      const userRef = db.collection("users").doc(hotelData.ownerUid);
      batch.set(
        userRef,
        {
          subscriptionActive: false,
        },
        { merge: true }
      );
    }

    await batch.commit();
    return { activated: false, deactivated: true };
  }

  const nextOrderDoc = upcomingSnap.docs[0];
  const nextOrder = nextOrderDoc.data() || {};

  const startDate =
    nextOrder.planStartDate && nextOrder.planStartDate.toDate
      ? nextOrder.planStartDate.toDate()
      : null;

  // if next plan has not started yet, keep expired state
  if (!startDate || startDate.getTime() > now.getTime()) {
    const batch = db.batch();

    batch.set(
      freshHotelSnap.ref,
      {
        subscriptionActive: false,
      },
      { merge: true }
    );

    if (hotelData.ownerUid) {
      const userRef = db.collection("users").doc(hotelData.ownerUid);
      batch.set(
        userRef,
        {
          subscriptionActive: false,
        },
        { merge: true }
      );
    }

    await batch.commit();
    return { activated: false, deactivated: true };
  }

  const nextValidTill =
    nextOrder.validTill && nextOrder.validTill.toDate
      ? nextOrder.validTill.toDate()
      : addPlanDuration(startDate, nextOrder.planKey);

  const batch = db.batch();

  // activate current plan on hotel
  batch.set(
    freshHotelSnap.ref,
    {
      subscriptionActive: true,
      planKey: nextOrder.planKey,
      validTill: admin.firestore.Timestamp.fromDate(nextValidTill),
      ownerUid: nextOrder.uid || hotelData.ownerUid || null,

      // clear upcoming fields because this plan is now current
      upcomingPlanKey: admin.firestore.FieldValue.delete(),
      upcomingPlanStartDate: admin.firestore.FieldValue.delete(),
      upcomingPlanValidTill: admin.firestore.FieldValue.delete(),
    },
    { merge: true }
  );

  // activate current plan on user doc
  if (nextOrder.uid) {
    const userRef = db.collection("users").doc(nextOrder.uid);
    batch.set(
      userRef,
      {
        subscriptionActive: true,
        planKey: nextOrder.planKey,
        validTill: admin.firestore.Timestamp.fromDate(nextValidTill),
        lastPaymentOrderId: nextOrderDoc.id,
        lastPaymentId: nextOrder.razorpay_payment_id || null,
      },
      { merge: true }
    );
  }

  // mark this order as no longer upcoming
  batch.set(
    nextOrderDoc.ref,
    {
      isUpcoming: false,
      activatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  await batch.commit();
  return { activated: true, deactivated: false };
}

function mustAuth(req) {
  if (!req.auth) {
    throw new HttpsError("unauthenticated", "Login required");
  }
}

function razorpayClient() {
  const keyId = RAZORPAY_KEY_ID.value();
  const keySecret = process.env.RAZORPAY_KEY_SECRET || RAZORPAY_KEY_SECRET.value();

  if (!keyId || !keySecret) {
    throw new HttpsError("failed-precondition", "Razorpay keys not set (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).");
  }

  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateForEmail(dateValue) {
  const d = parseFirestoreDate(dateValue) || new Date(dateValue);
  if (!(d instanceof Date) || isNaN(d.getTime())) return "-";

  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

function formatAmountInRupees(amountPaise) {
  const rupees = Number(amountPaise || 0) / 100;
  return rupees.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function getBillingCycleFromPlanKey(planKey) {
  return String(planKey || "").endsWith("_yearly") ? "Yearly" : "Monthly";
}

function getPlanDisplayName(planKey) {
  const key = String(planKey || "").toLowerCase();

  if (key.startsWith("starter_")) return "Starter Plan";
  if (key.startsWith("pro_")) return "Pro Plan";

  return planKey || "Subscription Plan";
}

function rowHtml(label, value, highlight = false, withBorder = true) {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
  <tr>
    <td style="padding:14px 0;${withBorder ? "border-bottom:1px solid rgba(71,85,105,0.5);" : ""}color:#e5e7eb;font-size:14px;">
      ${escapeHtml(label)}
    </td>
    <td align="right" style="padding:14px 0;${withBorder ? "border-bottom:1px solid rgba(71,85,105,0.5);" : ""}color:${highlight ? "#ff7a00" : "#ffffff"};font-size:14px;font-weight:${highlight ? "700" : "600"};">
      ${value}
    </td>
  </tr>
</table>
`;
}

function buildSubscriptionSuccessEmailHtml({
  hotelName,
  planName,
  billingCycle,
  amountPaid,
  transactionId,
  startDate,
  nextBillingDate,
  dashboardUrl,
  supportEmail,
}) {
  const safeHotelName = escapeHtml(hotelName || "Hotel");
  const safePlanName = escapeHtml(planName || "Subscription Plan");
  const safeBillingCycle = escapeHtml(billingCycle || "-");
  const safeAmountPaid = escapeHtml(amountPaid || "0.00");
  const safeTransactionId = escapeHtml(transactionId || "-");
  const safeStartDate = escapeHtml(startDate || "-");
  const safeNextBillingDate = escapeHtml(nextBillingDate || "-");
  const safeDashboardUrl = escapeHtml(dashboardUrl || "https://hotelmenupro.com");
  const safeSupportEmail = escapeHtml(supportEmail || "hotelmenupro@gmail.com");

  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>HotelMenuPro - Subscription Confirmed</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:Arial,Helvetica,sans-serif;">
  <div style="width:100%;background:#0f172a;padding:32px 16px;">
    <div style="max-width:680px;margin:0 auto;">
      <div style="text-align:center;padding:20px 0 28px 0;">
        <div style="font-size:28px;font-weight:700;letter-spacing:-0.02em;">
          <span style="color:#e5e7eb;">Hotel</span><span style="color:#ff7a00;">MenuPro</span>
        </div>
      </div>

      <div style="text-align:center;margin-bottom:28px;">
        <h1 style="margin:0 0 12px 0;color:#ffffff;font-size:32px;line-height:1.2;font-weight:700;">
          Your Subscription is <span style="color:#ff7a00;">Active!</span>
        </h1>
        <p style="margin:0 auto;color:#e5e7eb;font-size:16px;line-height:1.7;max-width:520px;">
          Thank you for choosing HotelMenuPro. Your digital menu platform is now ready to transform your hotel's dining experience.
        </p>
      </div>

      <div style="background:#111827;border-radius:18px;padding:28px;margin-bottom:28px;">
        <h2 style="margin:0 0 20px 0;color:#ffffff;font-size:20px;font-weight:700;">Subscription Details</h2>

        ${rowHtml("Hotel Name", safeHotelName, true)}
        ${rowHtml("Plan Name", safePlanName, true)}
        ${rowHtml("Billing Cycle", safeBillingCycle, false)}
        ${rowHtml("Amount Paid", "₹" + safeAmountPaid, true)}
        ${rowHtml("Transaction ID", safeTransactionId, false)}
        ${rowHtml("Start Date", safeStartDate, false)}
        ${rowHtml("Next Billing Date", safeNextBillingDate, true, false)}
      </div>

      <div style="text-align:center;margin-bottom:28px;">
        <a href="${safeDashboardUrl}" style="display:inline-block;background:#ff7a00;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:12px;">
          Go to Dashboard
        </a>
      </div>

      <div style="background:#111827;border-radius:18px;padding:28px;margin-bottom:28px;">
        <h3 style="margin:0 0 18px 0;color:#ffffff;font-size:18px;font-weight:700;">What You Can Do</h3>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            <td style="color:#e5e7eb;font-size:14px;padding:8px 0;">✓ Create digital menu</td>
            <td style="color:#e5e7eb;font-size:14px;padding:8px 0;">✓ Update prices anytime</td>
          </tr>
          <tr>
            <td style="color:#e5e7eb;font-size:14px;padding:8px 0;">✓ Generate QR code</td>
            <td style="color:#e5e7eb;font-size:14px;padding:8px 0;">✓ Download & print</td>
          </tr>
        </table>
      </div>

      <div style="text-align:center;padding-top:18px;border-top:1px solid #1f2937;">
        <p style="margin:0 0 8px 0;color:rgba(229,231,235,0.75);font-size:14px;">
          Need help? Contact us at
          <a href="mailto:${safeSupportEmail}" style="color:#ff7a00;text-decoration:none;">${safeSupportEmail}</a>
        </p>
        <p style="margin:0;color:rgba(229,231,235,0.45);font-size:12px;">© 2026 HotelMenuPro. All rights reserved.</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function sendSubscriptionSuccessEmail({
  to,
  hotelName,
  hotelSlug,
  planKey,
  amount,
  razorpayPaymentId,
  startDate,
  validTill,
}) {
  if (!to) {
    throw new Error("Recipient email missing");
  }

  const resend = new Resend(RESEND_API_KEY.value());

  const billingCycle = getBillingCycleFromPlanKey(planKey);
  const planName = getPlanDisplayName(planKey);
  const dashboardUrl = hotelSlug
    ? `${APP_BASE_URL.replace(/\/$/, "")}/dashboard/${hotelSlug}`
    : APP_BASE_URL;

  const subject = `Your ${planName} is now active - HotelMenuPro`;

  const html = buildSubscriptionSuccessEmailHtml({
    hotelName,
    planName,
    billingCycle,
    amountPaid: formatAmountInRupees(amount),
    transactionId: razorpayPaymentId,
    startDate: formatDateForEmail(startDate),
    nextBillingDate: formatDateForEmail(validTill),
    dashboardUrl,
    supportEmail: SUPPORT_EMAIL,
  });

  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM,
    to: [to],
    subject,
    html,
  });

  if (error) {
    throw new Error(error.message || "Resend send failed");
  }

  return data;
}

// ✅ 1) Create order (callable)
exports.createSubscriptionOrder = onCall(
  { region: REGION, secrets: [RAZORPAY_KEY_SECRET] }, // key id is string param; secret must be listed here
  async (req) => {
    mustAuth(req);

    const uid = req.auth.uid;
    const { planKey, hotelSlug } = req.data || {};

    if (!planKey || !PLANS[planKey]) {
      throw new HttpsError("invalid-argument", "Invalid plan");
    }

    // ✅ anti-abuse: limit 1 active order create per 15 seconds per user
    const throttleRef = db.collection("orderThrottle").doc(uid);
    const throttleSnap = await throttleRef.get();
    const now = Date.now();

    if (throttleSnap.exists) {
      const last = throttleSnap.data().lastCreatedAt || 0;
      if (now - last < 15000) {
        throw new HttpsError("resource-exhausted", "Too many attempts. Try again.");
      }
    }

    await throttleRef.set({ lastCreatedAt: now }, { merge: true });

    const rz = razorpayClient();

let order;
try {

  // ✅ keep receipt <= 40 chars (Razorpay limit)
  const uidShort = String(uid).slice(-10);        // last 10 chars
  const tsShort = Date.now().toString().slice(-10); // last 10 digits

  order = await rz.orders.create({
    amount: PLANS[planKey],
    currency: "INR",
    receipt: `sub_${uidShort}_${tsShort}`, // ✅ short receipt
    notes: { uid, hotelSlug: hotelSlug || "", planKey },
  });

} catch (err) {
  console.error("❌ Razorpay orders.create failed:", err);
  throw new HttpsError(
    "internal",
    "Razorpay order creation failed. Check function logs for details.",
    {
      message: err?.message,
      statusCode: err?.statusCode,
      error: err?.error,
    }
  );
}

await db.collection("subscriptionOrders").doc(order.id).set({
  uid,
  hotelSlug: hotelSlug || null,
  planKey,
  amount: order.amount,
  currency: order.currency,
  status: "created",
  createdAt: admin.firestore.FieldValue.serverTimestamp(),
});

// ✅ return the real key id from params
return {
  keyId: RAZORPAY_KEY_ID.value(),
  orderId: order.id,
  amount: order.amount,
  currency: order.currency,
};
  }
);

// ✅ 2) Verify payment + activate subscription (callable)
exports.verifySubscriptionPayment = onCall(
  { region: REGION, secrets: [RAZORPAY_KEY_SECRET, RESEND_API_KEY] },
  async (req) => {
    mustAuth(req);

    const uid = req.auth.uid;
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.data || {};

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      throw new HttpsError("invalid-argument", "Missing payment fields");
    }

    const orderRef = db.collection("subscriptionOrders").doc(razorpay_order_id);
    const orderSnap = await orderRef.get();

    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Order not found");
    }

    const orderData = orderSnap.data() || {};
    if (orderData.uid !== uid) {
      throw new HttpsError("permission-denied", "Not your order");
    }

    if (orderData.status === "paid") {
      return { success: true, alreadyDone: true };
    }

    const secret = RAZORPAY_KEY_SECRET.value();
    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expected = crypto
      .createHmac("sha256", secret)
      .update(body.toString())
      .digest("hex");

    if (expected !== razorpay_signature) {
      await orderRef.set(
        {
          status: "failed",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      throw new HttpsError("permission-denied", "Invalid signature");
    }

    const planKey = orderData.planKey;
    const now = new Date();

    let startDate = new Date(now);
    let hotelRef = null;
    let hotelData = null;

    if (orderData.hotelSlug) {
      hotelRef = db.collection("hotels").doc(orderData.hotelSlug);
      const hotelSnap = await hotelRef.get();

      if (hotelSnap.exists) {
        hotelData = hotelSnap.data() || {};
        const currentValidTill = parseFirestoreDate(hotelData.validTill);

        if (currentValidTill && currentValidTill.getTime() > now.getTime()) {
          startDate = new Date(currentValidTill);
        }
      }
    }

    let validTill = new Date(startDate);

    if (String(planKey).endsWith("_monthly")) {
      validTill.setMonth(validTill.getMonth() + 1);
    }

    if (String(planKey).endsWith("_yearly")) {
      validTill.setFullYear(validTill.getFullYear() + 1);
    }

    const isUpcoming = startDate.getTime() > now.getTime();
    const batch = db.batch();

    batch.set(
      orderRef,
      {
        status: "paid",
        razorpay_payment_id,
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        planStartDate: admin.firestore.Timestamp.fromDate(startDate),
        validTill: admin.firestore.Timestamp.fromDate(validTill),
        isUpcoming,
      },
      { merge: true }
    );

    const userRef = db.collection("users").doc(uid);

    if (!isUpcoming) {
      batch.set(
        userRef,
        {
          subscriptionActive: true,
          planKey,
          validTill: admin.firestore.Timestamp.fromDate(validTill),
          lastPaymentOrderId: razorpay_order_id,
          lastPaymentId: razorpay_payment_id,
        },
        { merge: true }
      );
    }

    if (hotelRef) {
      if (!isUpcoming) {
        batch.set(
          hotelRef,
          {
            subscriptionActive: true,
            planKey,
            validTill: admin.firestore.Timestamp.fromDate(validTill),
            ownerUid: uid,
            upcomingPlanKey: admin.firestore.FieldValue.delete(),
            upcomingPlanStartDate: admin.firestore.FieldValue.delete(),
            upcomingPlanValidTill: admin.firestore.FieldValue.delete(),
          },
          { merge: true }
        );
      } else {
        batch.set(
          hotelRef,
          {
            upcomingPlanKey: planKey,
            upcomingPlanStartDate: admin.firestore.Timestamp.fromDate(startDate),
            upcomingPlanValidTill: admin.firestore.Timestamp.fromDate(validTill),
          },
          { merge: true }
        );
      }
    }

    await batch.commit();

    try {
      const recipientEmail = String(hotelData?.ownerEmail || "").trim();
      const hotelName = String(hotelData?.hotelName || orderData.hotelSlug || "Hotel").trim();

      if (recipientEmail) {
        const resendResult = await sendSubscriptionSuccessEmail({
          to: recipientEmail,
          hotelName,
          hotelSlug: orderData.hotelSlug || "",
          planKey,
          amount: orderData.amount,
          razorpayPaymentId: razorpay_payment_id,
          startDate,
          validTill,
        });

        await orderRef.set(
          {
            emailSent: true,
            emailSentAt: admin.firestore.FieldValue.serverTimestamp(),
            emailSentTo: recipientEmail,
            resendEmailId: resendResult?.id || null,
            emailError: admin.firestore.FieldValue.delete(),
          },
          { merge: true }
        );
      } else {
        await orderRef.set(
          {
            emailSent: false,
            emailError: "ownerEmail missing on hotel document",
          },
          { merge: true }
        );
      }
    } catch (mailErr) {
      console.error("❌ Subscription success email failed:", mailErr);

      await orderRef.set(
        {
          emailSent: false,
          emailError: String(mailErr?.message || mailErr),
        },
        { merge: true }
      );
    }

    return { success: true, validTill: validTill.toISOString() };
  }
);
// ✅ 3) Auto-activate upcoming plans when current plan expires
exports.autoActivateUpcomingPlans = onSchedule(
  {
    region: REGION,
    schedule: "every 1 minutes",
    timeZone: "Asia/Kolkata",
  },
  async () => {
    const now = new Date();
    const nowTs = admin.firestore.Timestamp.fromDate(now);

    try {
      const dueUpcomingSnap = await db
        .collection("subscriptionOrders")
        .where("status", "==", "paid")
        .where("isUpcoming", "==", true)
        .where("planStartDate", "<=", nowTs)
        .orderBy("planStartDate", "asc")
        .get();

      let activatedCount = 0;
      let deactivatedCount = 0;

      // 1) activate due upcoming plans
      for (const orderDoc of dueUpcomingSnap.docs) {
        try {
          const orderData = orderDoc.data() || {};
          const hotelSlug = orderData.hotelSlug;

          if (!hotelSlug) continue;

          const hotelRef = db.collection("hotels").doc(hotelSlug);
          const hotelSnap = await hotelRef.get();

          if (!hotelSnap.exists) {
            console.error(`❌ Hotel not found for upcoming order ${orderDoc.id}: ${hotelSlug}`);
            continue;
          }

          const result = await activateUpcomingPlanForHotel(hotelSnap);
          if (result?.activated) activatedCount++;
          if (result?.deactivated) deactivatedCount++;
        } catch (err) {
          console.error(`❌ Failed activating due upcoming order ${orderDoc.id}:`, err);
        }
      }

      // 2) deactivate expired hotels that have no upcoming plan
// fetch active hotels first, then filter expired ones in code
const activeHotelsSnap = await db
  .collection("hotels")
  .where("subscriptionActive", "==", true)
  .get();

for (const hotelDoc of activeHotelsSnap.docs) {
  try {
    const hotelData = hotelDoc.data() || {};
    const validTillDate = parseFirestoreDate(hotelData.validTill);

    // only skip hotels whose plan is still valid
    if (validTillDate && validTillDate.getTime() > now.getTime()) {
      continue;
    }

    // if validTill is missing, invalid, or already expired,
    // process it and deactivate if no upcoming plan exists
    const result = await activateUpcomingPlanForHotel(hotelDoc);
    if (result?.activated) activatedCount++;
    if (result?.deactivated) deactivatedCount++;
  } catch (err) {
    console.error(`❌ Failed processing expired hotel ${hotelDoc.id}:`, err);
  }
}

      console.log(`✅ Auto activation finished. Activated: ${activatedCount}, Deactivated: ${deactivatedCount}`);
      return null;
    } catch (err) {
      console.error("❌ autoActivateUpcomingPlans failed:", err);
      throw err;
    }
  }
);
/* ============================================================
   SUPER ADMIN AUTH SYSTEM (SAFE ADDITION)
   ============================================================ */

function allowCors(req, res) {
  const origin = req.headers.origin || "http://127.0.0.1:5000";

  res.set("Access-Control-Allow-Origin", origin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Credentials", "true");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }

  return false;
}


const SUPER_ADMIN_EMAIL = "hotelmenupro@gmail.com";
const SESSION_DURATION = 12 * 60 * 60 * 1000; // 12 hours

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function createSessionId() {
  return crypto.randomBytes(32).toString("hex");
}

async function createSuperAdminSession(email) {
  const sessionId = createSessionId();
  const expiresAt = new Date(Date.now() + SESSION_DURATION);

  await db.collection("superAdminSessions").doc(sessionId).set({
    email,
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return sessionId;
}

async function verifySessionToken(sessionId) {
  try {
    if (!sessionId) return null;

    const snap = await db.collection("superAdminSessions").doc(sessionId).get();
    if (!snap.exists) return null;

    const data = snap.data() || {};
    const expiresAt =
      data.expiresAt && typeof data.expiresAt.toDate === "function"
        ? data.expiresAt.toDate()
        : null;

    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      await db.collection("superAdminSessions").doc(sessionId).delete().catch(() => {});
      return null;
    }

    return {
      sessionId,
      ...data
    };
  } catch (e) {
    console.error("verifySessionToken failed:", e);
    return null;
  }
}
async function getSuperAdminSessionFromRequest(req) {
  try {
    const cookies = cookie.parse(req.headers.cookie || "");
    const cookieToken = cookies.superAdminSession || "";
    const headerToken = req.headers["x-super-admin-session"] || "";

    const token = cookieToken || headerToken;
    if (!token) return null;

    return await verifySessionToken(token);
  } catch (e) {
    console.error("getSuperAdminSessionFromRequest failed:", e);
    return null;
  }
}

async function deleteSessionToken(sessionId) {
  try {
    if (!sessionId) return;
    await db.collection("superAdminSessions").doc(sessionId).delete();
  } catch (e) {
    console.error("Failed to delete super admin session:", e);
  }
}

/* ============================================================
   SUPER ADMIN LOGIN
   POST /api/super-admin/login
   ============================================================ */

   function getSessionCookieOptions(req, isClearing = false) {
  const host = String(req.headers.host || "").toLowerCase();

  const isLocalhost =
    host.includes("127.0.0.1") ||
    host.includes("localhost");

  const domain = isLocalhost ? undefined : host;

  return {
    httpOnly: true,
    secure: !isLocalhost,
    sameSite: isLocalhost ? "lax" : "strict",
    path: "/",
    domain: domain,
    maxAge: isClearing ? 0 : 60 * 60 * 12
  };
}
exports.superAdminLogin = onRequest(async (req, res) => {

  if (allowCors(req, res)) return;
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Missing credentials" });
    }

    if (email !== SUPER_ADMIN_EMAIL) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const adminRef = db.collection("superAdmins").doc(email);
    const adminDoc = await adminRef.get();

    if (!adminDoc.exists) {
      return res.status(401).json({ error: "Admin not found" });
    }

    const admin = adminDoc.data();

    const hashedInput = hashPassword(password);

    if (hashedInput !== admin.passwordHash) {
      return res.status(401).json({ error: "Invalid password" });
    }

    const token = await createSuperAdminSession(email);

    res.setHeader(
  "Set-Cookie",
  cookie.serialize(
    "superAdminSession",
    token,
    getSessionCookieOptions(req, false)
  )
);

    return res.json({ success: true, sessionId: token });
  } catch (err) {
    console.error("Super admin login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ============================================================
   VERIFY ADMIN SESSION
   GET /api/super-admin/me
   ============================================================ */

exports.superAdminMe = onRequest(async (req, res) => {
  if (allowCors(req, res)) return;

  const session = await getSuperAdminSessionFromRequest(req);

  if (!session) {
    return res.status(401).json({ authenticated: false });
  }

  return res.json({
    authenticated: true,
    email: session.email
  });
});

/* ============================================================
   LOGOUT
   ============================================================ */

exports.superAdminLogout = onRequest(async (req, res) => {
  if (allowCors(req, res)) return;

  const session = await getSuperAdminSessionFromRequest(req);
  const token = session?.sessionId || "";

  await deleteSessionToken(token);

  res.setHeader(
    "Set-Cookie",
    cookie.serialize(
      "superAdminSession",
      "",
      getSessionCookieOptions(req, true)
    )
  );

  res.json({ success: true });
});

/* ============================================================
   SUPER ADMIN DASHBOARD DATA
   ============================================================ */

exports.superAdminDashboardData = onRequest(async (req, res) => {

  if (allowCors(req, res)) return;

  try {
    const session = await getSuperAdminSessionFromRequest(req);

if (!session) {
  return res.status(401).json({ error: "Unauthorized" });
}

    const hotelsSnapshot = await db.collection("hotels").get();

    const hotels = [];
    let active = 0;
    let upcoming = 0;
    let expired = 0;

    hotelsSnapshot.forEach(doc => {
      const data = doc.data() || {};

      hotels.push({
        id: doc.id,
        ...data
      });

      if (data.subscriptionActive) active++;
      if (data.upcomingPlanKey) upcoming++;
      if (!data.subscriptionActive) expired++;
    });

    // ✅ Platform revenue = all paid subscription orders ever
    const filter = req.query.filter || "all";

let startDate = null;

if (filter === "today") {
  startDate = new Date();
  startDate.setHours(0,0,0,0);
}

if (filter === "7days") {
  startDate = new Date();
  startDate.setDate(startDate.getDate() - 7);
}

if (filter === "30days") {
  startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);
}

let ordersQuery = db
  .collection("subscriptionOrders")
  .where("status", "==", "paid");

const paidOrdersSnapshot = await ordersQuery.get();

    let totalRevenue = 0;
    let totalPaidOrders = 0;

    const revenueByPlan = {
      starter_monthly: 0,
      starter_yearly: 0,
      pro_monthly: 0,
      pro_yearly: 0
    };

    paidOrdersSnapshot.forEach(doc => {

  const order = doc.data() || {};

  const paidAt = order.paidAt?.toDate ? order.paidAt.toDate() : null;

  if (startDate && paidAt && paidAt < startDate) {
    return;
  }

  const amount = Number(order.amount || 0);
  const planKey = String(order.planKey || "");

  totalRevenue += amount;
  totalPaidOrders++;

  if (revenueByPlan.hasOwnProperty(planKey)) {
    revenueByPlan[planKey] += amount;
  }
});

    return res.json({
      totalHotels: hotels.length,
      activeSubscriptions: active,
      upcomingPlans: upcoming,
      expiredHotels: expired,
      totalRevenue,        // ✅ in paise
      totalPaidOrders,     // ✅ extra useful metric
      revenueByPlan,       // ✅ optional extra insight
      hotels
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Dashboard error" });
  }
});