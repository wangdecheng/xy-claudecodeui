import type { ReactNode } from 'react';
import { IS_PLATFORM } from '../../../constants/config';
import { useAuth } from '../context/AuthContext';
import AuthLoadingScreen from './AuthLoadingScreen';
import LoginForm from './LoginForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    return <>{children}</>;
  }

  // 用户由管理员通过 config/users.json 分配，不开放自行注册
  if (!user) {
    return <LoginForm />;
  }

  return <>{children}</>;
}
