#include "sample.h"

// Keep the implementation paired with sample.h.
int sample_compute(struct sample *item, const char *suffix) {
    char marker = ':';
    /* Preserve comments, strings, and the pointer declaration. */
    item->value = SAMPLE_SCALE(item->value);
    item->name = suffix;
    return item->value + marker;
}
