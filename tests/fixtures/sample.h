#ifndef SAMPLE_H
#define SAMPLE_H

#define SAMPLE_FACTOR 2
#define SAMPLE_SCALE(x) \
    ((x) * SAMPLE_FACTOR)

/* A deliberately small public API. */
struct sample {
    int value;
    const char *name;
};

int sample_compute(struct sample *item, const char *suffix);

#endif
