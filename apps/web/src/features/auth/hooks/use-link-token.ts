import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * The secret from an emailed link (`?token=`). It is kept in memory and removed from the address
 * at once, so it does not stay in the history, the address bar or a shared screenshot.
 */
export function useLinkToken(): string | null {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => new URLSearchParams(search).get('token'));
  useEffect(() => {
    if (search) navigate(pathname, { replace: true });
  }, [navigate, pathname, search]);
  return token;
}
