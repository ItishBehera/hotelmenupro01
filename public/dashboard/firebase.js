// public/dashboard/firebase.js
// Shared Firebase init for dashboard modules (HotelMenuPro)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

// ✅ Use SAME Firebase project everywhere (landing, menu, dashboard)
const firebaseConfig = {
  apiKey: "AIzaSyBKFbHkeyrF4BJDelyJpxzLkNmCaTdfnp0",
  authDomain: "hotelmenupro-3112d.firebaseapp.com",
  projectId: "hotelmenupro-3112d",
  storageBucket: "hotelmenupro-3112d.appspot.com",
  messagingSenderId: "486946335023",
  appId: "1:486946335023:web:60a59c3df7dbe6e0cd59dd"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
