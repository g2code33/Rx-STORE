/// RX Store Mobile Application
/// 
/// Built with Flutter for Android and iOS.
/// Features: Authentication, Browse, Install, Notifications, AI Assistant
/// 
/// Architecture: Feature-first with Provider state management

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import 'services/auth_service.dart';
import 'services/api_service.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(
    statusBarColor: Color(0xFF0F1419),
    statusBarIconBrightness: Brightness.light,
  ));
  
  runApp(const RxStoreApp());
}

class RxStoreApp extends StatelessWidget {
  const RxStoreApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        Provider<ApiService>(create: (_) => ApiService()),
        ChangeNotifierProvider<AuthService>(create: (_) => AuthService()),
      ],
      child: Consumer<AuthService>(
        builder: (context, auth, _) {
          return MaterialApp(
            title: 'RX Store',
            debugShowCheckedModeBanner: false,
            theme: ThemeData(
              brightness: Brightness.dark,
              primaryColor: const Color(0xFFFFD600),
              scaffoldBackgroundColor: const Color(0xFF0F1419),
              colorScheme: const ColorScheme.dark(
                primary: Color(0xFFFFD600),
                secondary: Color(0xFFFFE033),
                surface: Color(0xFF1A2332),
                background: Color(0xFF0F1419),
              ),
              fontFamily: 'Inter',
              appBarTheme: const AppBarTheme(
                backgroundColor: Color(0xFF0F1419),
                elevation: 0,
                centerTitle: true,
              ),
              cardTheme: CardTheme(
                color: const Color(0xFF1A2332),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(16),
                ),
              ),
              elevatedButtonTheme: ElevatedButtonThemeData(
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFFFFD600),
                  foregroundColor: const Color(0xFF0F1419),
                  padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                  textStyle: const TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 16,
                  ),
                ),
              ),
            ),
            home: auth.isAuthenticated ? const HomeScreen() : const LoginScreen(),
          );
        },
      ),
    );
  }
}
