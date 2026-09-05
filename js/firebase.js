import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  deleteDoc,
  onSnapshot,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ⚠️ 아래 값을 Firebase 콘솔 > 프로젝트 설정 > 내 앱 에서 복사한 값으로 바꿔주세요.
const firebaseConfig = {
  apiKey: "여기에_API_KEY_붙여넣기",
  authDomain: "여기에_AUTH_DOMAIN_붙여넣기",
  projectId: "여기에_PROJECT_ID_붙여넣기",
  storageBucket: "여기에_STORAGE_BUCKET_붙여넣기",
  messagingSenderId: "여기에_SENDER_ID_붙여넣기",
  appId: "여기에_APP_ID_붙여넣기"
};

const MIGRATION_FLAG_PREFIX = "periodTracker.migrated.";
const LOCAL_RECORDS_KEY = "periodTracker.records.v1";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

let unsubscribeRecords = null;

function dispatch(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
}

function cyclesCollection(uid) {
  return collection(db, "users", uid, "cycles");
}

function readLocalRecords() {
  try {
    const raw = localStorage.getItem(LOCAL_RECORDS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("로컬 기록을 읽지 못했습니다.", e);
    return [];
  }
}

async function migrateIfNeeded(uid) {
  const flagKey = MIGRATION_FLAG_PREFIX + uid;
  let alreadyMigrated = false;
  try {
    alreadyMigrated = localStorage.getItem(flagKey) === "true";
  } catch (e) {
    // localStorage 접근 실패 시 매번 마이그레이션을 시도하게 되어도 setDoc은 덮어쓰기라 안전함
  }
  if (alreadyMigrated) return;

  const localRecords = readLocalRecords();

  try {
    if (localRecords.length > 0) {
      const batch = writeBatch(db);
      localRecords.forEach((r) => {
        if (!r || !r.id || !r.startDate) return;
        const ref = doc(db, "users", uid, "cycles", r.id);
        batch.set(ref, {
          startDate: r.startDate,
          endDate: r.endDate || null,
          symptoms: Array.isArray(r.symptoms) ? r.symptoms : [],
          memo: r.memo || ""
        });
      });
      await batch.commit();
    }
    try {
      localStorage.setItem(flagKey, "true");
    } catch (e) {
      // 플래그 저장 실패해도 치명적이지 않음 (다음에 다시 시도될 뿐)
    }
  } catch (e) {
    console.error("기존 기록을 클라우드로 옮기지 못했습니다.", e);
    dispatch("pt-sync-error", { message: "기존 기록을 클라우드로 옮기지 못했습니다. 잠시 후 다시 시도해주세요." });
  }
}

function subscribeRecords(uid) {
  if (unsubscribeRecords) {
    unsubscribeRecords();
    unsubscribeRecords = null;
  }
  unsubscribeRecords = onSnapshot(
    cyclesCollection(uid),
    (snapshot) => {
      const records = snapshot.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          startDate: data.startDate,
          endDate: data.endDate || null,
          symptoms: Array.isArray(data.symptoms) ? data.symptoms : [],
          memo: data.memo || ""
        };
      });
      dispatch("pt-records-updated", { records: records });
    },
    (error) => {
      console.error("기록 동기화 중 오류가 발생했습니다.", error);
      dispatch("pt-sync-error", { message: "동기화 실패, 잠시 후 다시 시도해주세요." });
    }
  );
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    dispatch("pt-auth-signed-in", { uid: user.uid, email: user.email });
    await migrateIfNeeded(user.uid);
    subscribeRecords(user.uid);
  } else {
    if (unsubscribeRecords) {
      unsubscribeRecords();
      unsubscribeRecords = null;
    }
    dispatch("pt-auth-signed-out", {});
  }
});

window.PTFirebase = {
  signIn: function () {
    return signInWithPopup(auth, provider).catch(function (error) {
      console.error("로그인에 실패했습니다.", error);
      dispatch("pt-auth-error", { message: "로그인에 실패했습니다. 잠시 후 다시 시도해주세요." });
    });
  },

  signOutUser: function () {
    return signOut(auth).catch(function (error) {
      console.error("로그아웃에 실패했습니다.", error);
    });
  },

  setRecord: function (uid, id, data) {
    return setDoc(doc(db, "users", uid, "cycles", id), {
      startDate: data.startDate,
      endDate: data.endDate || null,
      symptoms: Array.isArray(data.symptoms) ? data.symptoms : [],
      memo: data.memo || ""
    }).catch(function (error) {
      console.error("기록을 저장하지 못했습니다.", error);
      dispatch("pt-sync-error", { message: "동기화 실패, 잠시 후 다시 시도해주세요." });
      throw error;
    });
  },

  deleteRecord: function (uid, id) {
    return deleteDoc(doc(db, "users", uid, "cycles", id)).catch(function (error) {
      console.error("기록을 삭제하지 못했습니다.", error);
      dispatch("pt-sync-error", { message: "동기화 실패, 잠시 후 다시 시도해주세요." });
      throw error;
    });
  }
};
