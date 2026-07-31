package browser

import (
	"context"
	"errors"
	"testing"
	"time"
)

func testAttachedBrowser() *Browser {
	gate := make(chan struct{}, 1)
	gate <- struct{}{}
	return &Browser{attached: true, operationGate: gate}
}

func TestAcquireOperationSerializesAttachedBrowser(t *testing.T) {
	b := testAttachedBrowser()
	release, err := b.AcquireOperation(context.Background())
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}

	waitCtx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := b.AcquireOperation(waitCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("second acquire while held = %v, want deadline exceeded", err)
	}

	release()
	releaseAgain, err := b.AcquireOperation(context.Background())
	if err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
	releaseAgain()
}

func TestAcquireOperationReleaseIsIdempotent(t *testing.T) {
	b := testAttachedBrowser()
	release, err := b.AcquireOperation(context.Background())
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	release()
	release()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	releaseAgain, err := b.AcquireOperation(ctx)
	if err != nil {
		t.Fatalf("acquire after double release: %v", err)
	}
	releaseAgain()
}

func TestAcquireOperationLauncherModeDoesNotBlock(t *testing.T) {
	b := &Browser{attached: false}
	release1, err := b.AcquireOperation(context.Background())
	if err != nil {
		t.Fatalf("first launcher acquire: %v", err)
	}
	release2, err := b.AcquireOperation(context.Background())
	if err != nil {
		t.Fatalf("second launcher acquire: %v", err)
	}
	release1()
	release2()
}
