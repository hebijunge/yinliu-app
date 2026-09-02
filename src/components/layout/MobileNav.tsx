import { NavLink } from 'react-router-dom';
import { Home, Library, User } from 'lucide-react';

export default function MobileNav() {
  const items = [
    { to: '/', icon: Home, label: '首页' },
    { to: '/library', icon: Library, label: '曲库' },
    { to: '/profile', icon: User, label: '我的' },
  ];

  return (
    <nav className="bg-[var(--bg-secondary)] border-t border-[var(--border)] px-2 pb-safe">
      <div className="flex justify-around items-center h-14">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex flex-col items-center justify-center gap-0.5 flex-1 py-1 ${
                isActive ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'
              }`
            }
          >
            <item.icon className="w-5 h-5" />
            <span className="text-[10px]">{item.label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
