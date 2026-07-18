import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { CheckIn } from './pages/CheckIn';

// The admin screens pull in Firestore and Auth — roughly two-thirds of the
// Firebase SDK. Loading them lazily keeps that weight off the check-in page,
// which is the one people open on a phone on a church wifi.
const AdminLayout = lazy(() => import('./pages/AdminLayout').then((m) => ({ default: m.AdminLayout })));
const AdminSettings = lazy(() => import('./pages/AdminSettings').then((m) => ({ default: m.AdminSettings })));
const AdminAttendance = lazy(() => import('./pages/AdminAttendance').then((m) => ({ default: m.AdminAttendance })));
const AdminMembers = lazy(() => import('./pages/AdminMembers').then((m) => ({ default: m.AdminMembers })));

const Loading = () => (
  <main className="page">
    <div className="spinner" />
  </main>
);

export default function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<CheckIn />} />
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminAttendance />} />
            <Route path="members" element={<AdminMembers />} />
            <Route path="settings" element={<AdminSettings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
