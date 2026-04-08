// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyApjMuw9UKQSRyLVAFTkIXxOkskxPyo7fc",
  authDomain: "lineup-helper.firebaseapp.com",
  projectId: "lineup-helper",
  storageBucket: "lineup-helper.firebasestorage.app",
  messagingSenderId: "130741038202",
  appId: "1:130741038202:web:589e443af927347f1edfc3",
  measurementId: "G-Y9B4V8GMEY"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);