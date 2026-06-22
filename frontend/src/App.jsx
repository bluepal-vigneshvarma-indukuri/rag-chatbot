import { Routes, Route, Navigate } from "react-router-dom";
import { useState, useEffect } from "react";
import { supabase } from "./lib/supabase";
import AuthPage from "./pages/AuthPage";
import ChatPage from "./pages/ChatPage";

function PrivateRoute({ session, children }) {
  if (!session) return <Navigate to="/auth" replace />;
  return children;
}

export default function App() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) =>
      setSession(s)
    );
    return () => listener.subscription.unsubscribe();
  }, []);

  if (session === undefined)
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );

  return (
    <Routes>
      <Route
        path="/auth"
        element={session ? <Navigate to="/" replace /> : <AuthPage />}
      />
      <Route
        path="/"
        element={
          <PrivateRoute session={session}>
            <ChatPage session={session} />
          </PrivateRoute>
        }
      />
      <Route
        path="/chat"
        element={
          <PrivateRoute session={session}>
            <ChatPage session={session} />
          </PrivateRoute>
        }
      />
      <Route path="/documents" element={<Navigate to="/" replace />} />
      <Route path="*" element={<Navigate to={session ? "/" : "/auth"} replace />} />
    </Routes>
  );
}
