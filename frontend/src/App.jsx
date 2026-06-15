import { Routes, Route, Navigate } from "react-router-dom";
import { useState, useEffect } from "react";
import { supabase } from "./lib/supabase";
import AuthPage from "./pages/AuthPage";
import DocumentsPage from "./pages/DocumentsPage";
import ChatPage from "./pages/ChatPage";

function PrivateRoute({ session, children }) {
  if (!session) return <Navigate to="/auth" replace />;
  return children;
}

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = loading

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) =>
      setSession(s)
    );
    return () => listener.subscription.unsubscribe();
  }, []);

  if (session === undefined)
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );

  return (
    <Routes>
      <Route
        path="/auth"
        element={session ? <Navigate to="/documents" replace /> : <AuthPage />}
      />
      <Route
        path="/documents"
        element={
          <PrivateRoute session={session}>
            <DocumentsPage session={session} />
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
      <Route path="*" element={<Navigate to={session ? "/documents" : "/auth"} replace />} />
    </Routes>
  );
}
