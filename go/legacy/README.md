# Go x402

## Installation

```bash
go get github.com/x402-foundation/x402/go
```

## Usage

### Accepting x402 Payments with a [Gin](https://github.com/gin-gonic/gin) Resource Server

```go
package main

import (
	"math/big"

	x402gin "github.com/x402-foundation/x402/go/pkg/gin"
	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()

	facilitatorConfig := &types.FacilitatorConfig{
		URL: "http://localhost:3000",
	}

	r.GET(
		"/joke",
		x402gin.PaymentMiddleware(
			big.NewFloat(0.0001),
			"0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
			x402gin.WithFacilitatorConfig(facilitatorConfig),
			x402gin.WithResource("http://localhost:4021/joke"),
		),
		func(c *gin.Context) {
			c.JSON(200, gin.H{
				"joke": "Why do programmers prefer dark mode? Because light attracts bugs!",
			})
		},
	)

	r.Run(":4021") // Start the server on 0.0.0.0:4021 (for windows "localhost:4021")
}
```
