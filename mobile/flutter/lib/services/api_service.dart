/// API Service for RX Store
/// Handles all communication with the backend API.

import 'package:dio/dio.dart';

class ApiService {
  static const String baseUrl = 'https://api.rxstore.com/v1';
  
  late final Dio _dio;
  String? _token;

  ApiService() {
    _dio = Dio(BaseOptions(
      baseUrl: baseUrl,
      connectTimeout: const Duration(seconds: 10),
      receiveTimeout: const Duration(seconds: 15),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    ));

    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) {
        if (_token != null) {
          options.headers['Authorization'] = 'Bearer $_token';
        }
        handler.next(options);
      },
      onError: (error, handler) {
        if (error.response?.statusCode == 401) {
          // Token expired, attempt refresh
        }
        handler.next(error);
      },
    ));
  }

  void setToken(String token) {
    _token = token;
  }

  // Apps
  Future<List<dynamic>> getApps({String? category, String? platform, String? search}) async {
    final params = <String, dynamic>{};
    if (category != null) params['category'] = category;
    if (platform != null) params['platform'] = platform;
    if (search != null) params['search'] = search;
    
    final response = await _dio.get('/apps', queryParameters: params);
    return response.data['data']['apps'] ?? [];
  }

  Future<Map<String, dynamic>> getAppDetail(String slug) async {
    final response = await _dio.get('/apps/$slug');
    return response.data['data'];
  }

  // Updates
  Future<Map<String, dynamic>> checkUpdate(String appId, String currentVersion, String platform) async {
    final response = await _dio.get('/updates/check', queryParameters: {
      'app': appId,
      'currentVersion': currentVersion,
      'platform': platform,
    });
    return response.data['data'];
  }

  // Auth
  Future<Map<String, dynamic>> login(String email, String password) async {
    final response = await _dio.post('/auth/login', data: {
      'email': email,
      'password': password,
    });
    _token = response.data['data']['token'];
    return response.data['data'];
  }

  Future<Map<String, dynamic>> register(String name, String email, String password) async {
    final response = await _dio.post('/auth/register', data: {
      'name': name,
      'email': email,
      'password': password,
    });
    _token = response.data['data']['token'];
    return response.data['data'];
  }

  // AI
  Future<String> chatWithAI(String message) async {
    final response = await _dio.post('/ai/chat', data: {'message': message});
    return response.data['data']['response'] ?? '';
  }
}
