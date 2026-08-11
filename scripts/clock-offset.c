#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
#include <sys/time.h>
#include <time.h>

static long long offset_ms(void) {
  const char *raw = getenv("PROTEIN_CLOCK_OFFSET_MS");
  if (raw == NULL || *raw == '\0') return 0;
  return strtoll(raw, NULL, 10);
}

static void add_offset(struct timespec *value) {
  long long milliseconds = offset_ms();
  value->tv_sec += milliseconds / 1000;
  value->tv_nsec += (milliseconds % 1000) * 1000000LL;
  if (value->tv_nsec >= 1000000000L) {
    value->tv_sec += 1;
    value->tv_nsec -= 1000000000L;
  } else if (value->tv_nsec < 0) {
    value->tv_sec -= 1;
    value->tv_nsec += 1000000000L;
  }
}

int clock_gettime(clockid_t clock_id, struct timespec *value) {
  static int (*real_clock_gettime)(clockid_t, struct timespec *) = NULL;
  if (real_clock_gettime == NULL) {
    real_clock_gettime = dlsym(RTLD_NEXT, "clock_gettime");
  }
  if (real_clock_gettime == NULL) {
    errno = ENOSYS;
    return -1;
  }
  int result = real_clock_gettime(clock_id, value);
  if (result == 0 && clock_id == CLOCK_REALTIME) add_offset(value);
  return result;
}

int gettimeofday(struct timeval *value, void *timezone) {
  static int (*real_gettimeofday)(struct timeval *, void *) = NULL;
  if (real_gettimeofday == NULL) {
    real_gettimeofday = dlsym(RTLD_NEXT, "gettimeofday");
  }
  if (real_gettimeofday == NULL) {
    errno = ENOSYS;
    return -1;
  }
  int result = real_gettimeofday(value, timezone);
  if (result == 0) {
    long long microseconds = value->tv_usec + offset_ms() * 1000LL;
    value->tv_sec += microseconds / 1000000LL;
    value->tv_usec = microseconds % 1000000LL;
    if (value->tv_usec < 0) {
      value->tv_sec -= 1;
      value->tv_usec += 1000000L;
    }
  }
  return result;
}

time_t time(time_t *output) {
  static time_t (*real_time)(time_t *) = NULL;
  if (real_time == NULL) real_time = dlsym(RTLD_NEXT, "time");
  if (real_time == NULL) {
    errno = ENOSYS;
    return (time_t)-1;
  }
  time_t value = real_time(NULL) + (time_t)(offset_ms() / 1000);
  if (output != NULL) *output = value;
  return value;
}
