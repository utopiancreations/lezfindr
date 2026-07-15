// Excerpt: lib/features/discovery/presentation/bloc/nearby_bloc.dart (Flutter)
//
// The BLoC behind the Nearby grid — the client half of the PostGIS query in
// ../api/discovery-nearby.ts. Verbose debug logging trimmed for readability;
// structure and logic are as shipped.
//
// What it demonstrates:
//   • user-keyed caching in a singleton bloc (and the account-leak bug that
//     shaped it),
//   • server-offset pagination with dedupe + full re-sort,
//   • optimistic UI for swipes,
//   • a rewarded-ad gate that fails open,
//   • typed failures mapped to user-facing messages at the edge of the layer.

import 'dart:async';
import 'dart:math' as math;

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:lezfindr/core/error/failures.dart';
import 'package:lezfindr/core/models/user_profile.dart';
import 'package:lezfindr/core/services/logger_service.dart';
import 'package:lezfindr/core/services/premium_service.dart';
import 'package:lezfindr/features/discovery/domain/usecases/get_nearby_users.dart';
import 'package:lezfindr/features/discovery/domain/usecases/like_user.dart';
import 'package:lezfindr/features/discovery/domain/usecases/pass_user.dart';
import 'package:lezfindr/shared/services/ad_service.dart';
import 'package:lezfindr/shared/services/swipe_service.dart';

part 'nearby_event.dart';
part 'nearby_state.dart';

class NearbyBloc extends Bloc<NearbyEvent, NearbyState> {
  // Use cases injected via get_it — the bloc never touches the API client
  // directly, so it unit-tests against fakes with no network in sight.
  final GetNearbyUsers getNearbyUsersUseCase;
  final LikeUser likeUserUseCase;
  final PassUser passUserUseCase;
  final SwipeService swipeService;

  static const int _basePageSize = 50;
  static const int _adPageSize = 50;

  // Cache fields. NearbyBloc is a lazySingleton (one instance for the app
  // lifetime), so the cache MUST be keyed to the user it was built for —
  // otherwise logout→login as a different user serves User A's grid to
  // User B. That exact leak is why this cache was once disabled entirely;
  // keying it by _cachedForUserId is the actual fix, and it bought back a
  // 15-minute window of instant tab switches.
  List<UserProfile>? _cachedNearbyUsers;
  DateTime? _lastCacheTime;
  String? _cachedForUserId;
  static const Duration _cacheValidDuration = Duration(minutes: 15);

  // After a local list mutation (e.g. removing a blocked user in place),
  // suppress auth-triggered refreshes briefly — the local state is already
  // correct, and a refetch would visibly reshuffle the grid.
  DateTime? _lastLocalOptimizationTime;
  static const Duration _optimizationGracePeriod = Duration(minutes: 2);

  NearbyBloc({
    required this.getNearbyUsersUseCase,
    required this.likeUserUseCase,
    required this.passUserUseCase,
    required this.swipeService,
  }) : super(NearbyInitial()) {
    on<LoadNearbyUsers>(_onLoadNearbyUsers);
    on<LoadMoreNearbyUsers>(_onLoadMoreNearbyUsers);
    on<WatchAdForMoreUsers>(_onWatchAdForMoreUsers);
    on<RefreshNearbyUsers>(_onRefreshNearbyUsers);
    on<LikeProfile>(_onLikeProfile);
    on<PassProfile>(_onPassProfile);
    on<RemoveUserFromNearby>(_onRemoveUserFromNearby);
    on<ResetNearby>(_onResetNearby);
  }

  void _onResetNearby(ResetNearby event, Emitter<NearbyState> emit) {
    _cachedNearbyUsers = null;
    _lastCacheTime = null;
    _cachedForUserId = null;
    _lastLocalOptimizationTime = null;
    emit(NearbyInitial());
  }

  bool _isCacheValid(String currentUserId) {
    if (_cachedNearbyUsers == null || _lastCacheTime == null) return false;
    // Never serve a cache built for a different user (see field comment).
    if (_cachedForUserId != currentUserId) return false;
    return DateTime.now().difference(_lastCacheTime!) < _cacheValidDuration;
  }

  /// Haversine distance in km — used to backfill `distance` for profiles the
  /// server returned without one, so the whole grid sorts consistently.
  double _calculateDistance(double lat1, double lon1, double lat2, double lon2) {
    const double earthRadius = 6371.0;
    final double dLat = _degreeToRadian(lat2 - lat1);
    final double dLon = _degreeToRadian(lon2 - lon1);
    final double a = math.sin(dLat / 2) * math.sin(dLat / 2) +
        math.cos(_degreeToRadian(lat1)) *
            math.cos(_degreeToRadian(lat2)) *
            math.sin(dLon / 2) *
            math.sin(dLon / 2);
    return earthRadius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));
  }

  double _degreeToRadian(double degree) => degree * (math.pi / 180);

  List<UserProfile> _sortUsersByDistance(
    List<UserProfile> users,
    double? userLatitude,
    double? userLongitude,
  ) {
    if (userLatitude == null || userLongitude == null) return users;

    final usersWithDistance = <UserProfile>[
      for (final user in users)
        if (user.distance == null && user.location?.geoPoint != null)
          user.copyWith(
            distance: _calculateDistance(
              userLatitude,
              userLongitude,
              user.location!.geoPoint!.latitude,
              user.location!.geoPoint!.longitude,
            ),
          )
        else
          user,
    ];

    // Profiles with a known distance sort first; unknown-distance profiles
    // keep their server order at the end rather than being dropped.
    usersWithDistance.sort((a, b) {
      if (a.distance != null && b.distance != null) {
        return a.distance!.compareTo(b.distance!);
      }
      if (a.distance != null) return -1;
      if (b.distance != null) return 1;
      return 0;
    });
    return usersWithDistance;
  }

  Future<void> _onLoadNearbyUsers(
    LoadNearbyUsers event,
    Emitter<NearbyState> emit,
  ) async {
    if (event.currentUserId.isEmpty) {
      emit(const NearbyError(message: 'User ID was missing, could not fetch users.'));
      return;
    }

    if (_isCacheValid(event.currentUserId) && _cachedNearbyUsers != null) {
      final maxUsers = PremiumService.instance.isPremium ? 500 : 300;
      emit(NearbyUsersLoaded(
        users: _cachedNearbyUsers!,
        hasReachedMax: _cachedNearbyUsers!.length < _basePageSize,
        totalLoadedUsers: _cachedNearbyUsers!.length,
        canLoadMore: _cachedNearbyUsers!.length >= _basePageSize &&
            _cachedNearbyUsers!.length < maxUsers,
        showAdButton: _cachedNearbyUsers!.length >= _basePageSize,
      ));
      return;
    }

    emit(NearbyLoading());

    final prefs = await SharedPreferences.getInstance();
    final lastAdWatchTime =
        prefs.getInt('nearby_last_ad_watch_time_${event.currentUserId}');

    final failureOrUsers = await getNearbyUsersUseCase(
      GetNearbyUsersParams(
        currentUserId: event.currentUserId,
        location: LatLng(event.latitude ?? 0.0, event.longitude ?? 0.0),
        limit: _basePageSize,
        offset: 0,
      ),
    );

    // Either<Failure, Result> everywhere: repositories never throw across
    // the layer boundary, so every failure path is handled or it doesn't
    // compile past review.
    failureOrUsers.fold(
      (failure) => emit(NearbyError(message: _mapFailureToMessage(failure))),
      (result) {
        final sortedUsers =
            _sortUsersByDistance(result.items, event.latitude, event.longitude);

        _cachedNearbyUsers = sortedUsers;
        _lastCacheTime = DateTime.now();
        _cachedForUserId = event.currentUserId;

        final maxUsers = PremiumService.instance.isPremium ? 500 : 300;
        emit(NearbyUsersLoaded(
          users: sortedUsers,
          hasReachedMax: !result.hasMore,
          totalLoadedUsers: sortedUsers.length,
          serverOffset: result.newOffset,
          lastAdWatchTime: lastAdWatchTime != null
              ? DateTime.fromMillisecondsSinceEpoch(lastAdWatchTime)
              : null,
          canLoadMore: result.hasMore && sortedUsers.length < maxUsers,
          showAdButton: result.hasMore && sortedUsers.length >= _basePageSize,
        ));
      },
    );
  }

  Future<void> _onLoadMoreNearbyUsers(
    LoadMoreNearbyUsers event,
    Emitter<NearbyState> emit,
  ) async {
    if (event.currentUserId.isEmpty) return;
    final currentState = state;
    if (currentState is! NearbyUsersLoaded) return;
    if (currentState.hasReachedMax || !currentState.canLoadMore) return;

    emit(NearbyLoadingMore(currentUsers: currentState.users));

    final failureOrUsers = await getNearbyUsersUseCase(
      GetNearbyUsersParams(
        currentUserId: event.currentUserId,
        location: LatLng(event.latitude ?? 0.0, event.longitude ?? 0.0),
        limit: _adPageSize,
        // Pagination cursor is the SERVER's offset, not users.length — local
        // removals (swipes, blocks) shrink the list and would otherwise make
        // the next page overlap the previous one.
        offset: currentState.serverOffset,
      ),
    );

    failureOrUsers.fold(
      (failure) => emit(NearbyError(message: _mapFailureToMessage(failure))),
      (result) {
        // Dedupe by uid: a profile can move between pages while we paginate
        // (someone closer signs up, someone else goes inactive).
        final existingUserIds =
            currentState.users.map((user) => user.uid).toSet();
        final uniqueNewUsers = result.items
            .where((user) => !existingUserIds.contains(user.uid))
            .toList();

        // Re-sort the COMBINED list, not just the new page — batches can
        // arrive slightly out of distance order, and appending them raw made
        // the grid visibly "jump" on every page load.
        final sortedAllUsers = _sortUsersByDistance(
          [...currentState.users, ...uniqueNewUsers],
          event.latitude,
          event.longitude,
        );

        // Progress toward the cap counts server fetches, not UI length —
        // otherwise every local removal would grant bonus page budget.
        final totalFetched =
            currentState.totalLoadedUsers + result.items.length;
        final maxUsers = PremiumService.instance.isPremium ? 500 : 300;

        emit(currentState.copyWith(
          users: sortedAllUsers,
          totalLoadedUsers: totalFetched,
          serverOffset: result.newOffset,
          hasReachedMax: !result.hasMore,
          canLoadMore: result.hasMore && totalFetched < maxUsers,
        ));
      },
    );
  }

  Future<void> _onWatchAdForMoreUsers(
    WatchAdForMoreUsers event,
    Emitter<NearbyState> emit,
  ) async {
    if (event.currentUserId.isEmpty) return;
    final currentState = state;
    if (currentState is! NearbyUsersLoaded) return;

    emit(NearbyAdLoading(currentUsers: currentState.users));

    // Show a real rewarded ad. (This replaced a fake 2-second delay that
    // granted the reward without ever showing an ad — dead revenue on the
    // highest-eCPM, fully opt-in placement in the app.) Deliberately fails
    // open: if no ad fills, the user still gets more profiles — never punish
    // someone who tapped "watch ad" in good faith.
    final adCompleter = Completer<void>();
    AdService.showRewardedAd(
      placement: 'nearby_more',
      onAdComplete: () {
        if (!adCompleter.isCompleted) adCompleter.complete();
      },
      onAdFailed: () {
        if (!adCompleter.isCompleted) adCompleter.complete();
      },
    );
    await adCompleter.future;

    final now = DateTime.now();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt(
      'nearby_last_ad_watch_time_${event.currentUserId}',
      now.millisecondsSinceEpoch,
    );

    // Same pagination path as _onLoadMoreNearbyUsers from here on:
    // fetch at serverOffset, dedupe, re-sort combined list, emit.
    // (Body elided in this excerpt.)
  }

  Future<void> _onRefreshNearbyUsers(
    RefreshNearbyUsers event,
    Emitter<NearbyState> emit,
  ) async {
    if (event.currentUserId.isEmpty) return;

    // A recent local mutation means state is already correct; skip the
    // refetch instead of reshuffling the grid under the user's thumb.
    if (_lastLocalOptimizationTime != null &&
        DateTime.now().difference(_lastLocalOptimizationTime!) <
            _optimizationGracePeriod) {
      return;
    }

    // e.g. after blocking a user: nuke the cache and reload fresh.
    _cachedNearbyUsers = null;
    _lastCacheTime = null;
    _cachedForUserId = null;

    add(LoadNearbyUsers(
      currentUserId: event.currentUserId,
      latitude: event.latitude,
      longitude: event.longitude,
      resetPagination: true,
    ));
  }

  // Optimistic swipes: remove the card and record the swipe locally FIRST,
  // then persist. A swipe that fails server-side self-heals on the next
  // feed load; a UI that hangs on every swipe waiting for a roundtrip is
  // unusable on a bad connection.
  Future<void> _onLikeProfile(
    LikeProfile event,
    Emitter<NearbyState> emit,
  ) async {
    final currentState = state;
    if (currentState is NearbyUsersLoaded) {
      final updatedUsers = List<UserProfile>.from(currentState.users)
        ..removeWhere((user) => user.uid == event.likedUserId);
      swipeService.addSwipedUserId(event.likedUserId);
      emit(currentState.copyWith(users: updatedUsers));
      await likeUserUseCase(LikeUserParams(
        currentUserId: event.userId,
        targetUserId: event.likedUserId,
      ));
    }
  }

  Future<void> _onPassProfile(
    PassProfile event,
    Emitter<NearbyState> emit,
  ) async {
    final currentState = state;
    if (currentState is NearbyUsersLoaded) {
      final updatedUsers = List<UserProfile>.from(currentState.users)
        ..removeWhere((user) => user.uid == event.passedUserId);
      swipeService.addSwipedUserId(event.passedUserId);
      emit(currentState.copyWith(users: updatedUsers));
      await passUserUseCase(PassUserParams(
        currentUserId: event.userId,
        targetUserId: event.passedUserId,
      ));
    }
  }

  Future<void> _onRemoveUserFromNearby(
    RemoveUserFromNearby event,
    Emitter<NearbyState> emit,
  ) async {
    final currentState = state;
    if (currentState is NearbyUsersLoaded) {
      final updatedUsers = List<UserProfile>.from(currentState.users)
        ..removeWhere(
          (profile) => profile.id == event.userId || profile.uid == event.userId,
        );

      // Keep the cache consistent with what the user is looking at.
      _cachedNearbyUsers = _cachedNearbyUsers
          ?.where((p) => p.id != event.userId && p.uid != event.userId)
          .toList();

      _lastLocalOptimizationTime = DateTime.now();
      emit(currentState.copyWith(users: updatedUsers));
    } else {
      LoggerService.warning(
        'Cannot remove user - nearby not in loaded state: ${currentState.runtimeType}',
      );
    }
  }

  // Failures become user-facing copy exactly once, at the edge of the bloc.
  // Everything below this layer speaks typed Failure objects, never strings.
  String _mapFailureToMessage(Failure failure) {
    switch (failure.runtimeType) {
      case ServerFailure _:
        return 'Server error occurred. Please try again later.';
      case NetworkFailure _:
        return 'Network error occurred. Please check your connection.';
      case CacheFailure _:
        return 'Cache error occurred. Please try again.';
      default:
        return 'An unexpected error occurred. Please try again.';
    }
  }
}
