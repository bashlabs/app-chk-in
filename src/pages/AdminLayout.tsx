import { NavLink, Outlet } from 'react-router-dom';
import { signOut } from 'firebase/auth';

import { auth } from '../firebase';
import { useAuth } from '../lib/useAuth';
import { AdminLogin } from './AdminLogin';

export function AdminLayout() {
  const { user, isAdmin, loading, checkError } = useAuth();

  if (loading) {
    return (
      <main className="page">
        <div className="card">
          <div className="state">
            <div className="spinner" />
          </div>
        </div>
      </main>
    );
  }

  if (!user) return <AdminLogin />;

  // A denied admin *check* (rather than a check that ran and found nothing) is
  // a deployment problem, not a permissions verdict — don't tell a real admin
  // they aren't one.
  if (checkError) {
    return (
      <main className="page">
        <div className="card">
          <div className="state">
            <div className="badge warn" aria-hidden="true">
              !
            </div>
            <h2>Couldn’t verify admin access</h2>
            {checkError === 'permission-denied' ? (
              <p className="muted">
                Signed in as {user.email}, but reading your admin record was blocked. This usually
                means the Firestore security rules haven’t been deployed to this project. Deploy them
                (<code>npm run deploy:rules</code>, or paste them in the Firebase console) and reload.
              </p>
            ) : (
              <p className="muted">
                Signed in as {user.email}, but couldn’t reach the database to check your access.
                Check your connection and reload.
              </p>
            )}
            <button className="secondary" onClick={() => signOut(auth)}>
              Sign out
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className="page">
        <div className="card">
          <div className="state">
            <div className="badge warn" aria-hidden="true">
              !
            </div>
            <h2>No admin access</h2>
            <p className="muted">
              {user.email} isn’t an administrator. Ask an existing admin to grant access, then sign
              in again.
            </p>
            <button className="secondary" onClick={() => signOut(auth)}>
              Sign out
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <div className="admin">
      <header className="admin-bar">
        <nav>
          <NavLink to="/admin" end>
            Attendance
          </NavLink>
          <NavLink to="/admin/members">Members</NavLink>
          <NavLink to="/admin/settings">Access</NavLink>
        </nav>
        <div className="admin-user">
          <span className="muted small">{user.email}</span>
          <button className="link" onClick={() => signOut(auth)}>
            Sign out
          </button>
        </div>
      </header>
      <main className="admin-body">
        <Outlet />
      </main>
    </div>
  );
}
