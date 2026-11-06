package authcapture

import (
	"encoding/json"
	"fmt"
)

// ChargeCompletion carries the fields a server adds to a collect payload to complete
// a charge. FeeBps is nil when the payload uses feeAmount (v1.1). AuthorizerSignature is
// empty when the authorizer is delegated to the facilitator.
type ChargeCompletion struct {
	Amount              string
	FeeBps              *uint16
	FeeAmount           string
	FeeReceiver         string
	AuthorizerSignature string
}

// Eip3009CollectPayload is the parsed EIP-3009-shaped auth-capture collect payload.
type Eip3009CollectPayload struct {
	Authorization Eip3009Authorization
	Signature     string
	Salt          string
	SaltNonce     string
	Charge        *ChargeCompletion
}

// Permit2CollectPayload is the parsed Permit2-shaped auth-capture collect payload.
type Permit2CollectPayload struct {
	Permit2Authorization Permit2Authorization
	Signature            string
	Salt                 string
	SaltNonce            string
	Charge               *ChargeCompletion
}

// CapturePayload is the parsed capture lifecycle payload. Without a local signer (authorizer
// delegated to the facilitator) both signatures are empty and VoidRemainder asks the facilitator
// to sign the Void leg.
type CapturePayload struct {
	PaymentInfo              PaymentInfoStruct
	SaltNonce                string
	Amount                   string
	FeeBps                   *uint16
	FeeAmount                string
	FeeReceiver              string
	ExpectedCapturableAmount string
	ExpectedRefundableAmount string
	AuthorizerSignature      string
	VoidAuthorizerSignature  string
	VoidRemainder            bool
}

// VoidPayload is the parsed void lifecycle payload. VoidAuthorizerSignature is only
// parsed so the facilitator can reject it.
type VoidPayload struct {
	PaymentInfo             PaymentInfoStruct
	SaltNonce               string
	AuthorizerSignature     string
	VoidAuthorizerSignature string
}

// RefundPayload is the parsed refund lifecycle payload.
type RefundPayload struct {
	PaymentInfo              PaymentInfoStruct
	SaltNonce                string
	Amount                   string
	ExpectedCapturableAmount string
	ExpectedRefundableAmount string
	AuthorizerSignature      string
}

// ToWireMap returns the JSON wire form of the PaymentInfo carried by lifecycle payloads.
func (p PaymentInfoStruct) ToWireMap() (map[string]interface{}, error) {
	encoded, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	var out map[string]interface{}
	if err := json.Unmarshal(encoded, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Eip3009CollectPayloadFromMap parses a wire payload already confirmed by IsEip3009Payload.
func Eip3009CollectPayloadFromMap(data map[string]interface{}) (*Eip3009CollectPayload, error) {
	auth, ok := data["authorization"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid authorization field")
	}
	payload := &Eip3009CollectPayload{}
	payload.Authorization.From, _ = auth["from"].(string)
	payload.Authorization.To, _ = auth["to"].(string)
	payload.Authorization.Value, _ = auth["value"].(string)
	payload.Authorization.ValidAfter, _ = auth["validAfter"].(string)
	payload.Authorization.ValidBefore, _ = auth["validBefore"].(string)
	payload.Authorization.Nonce, _ = auth["nonce"].(string)

	payload.Signature, _ = data["signature"].(string)
	payload.Salt, _ = data["salt"].(string)
	payload.SaltNonce, _ = data["saltNonce"].(string)
	charge, err := chargeCompletionFromMap(data)
	if err != nil {
		return nil, err
	}
	payload.Charge = charge
	return payload, nil
}

// Permit2CollectPayloadFromMap parses a wire payload already confirmed by IsPermit2Payload.
func Permit2CollectPayloadFromMap(data map[string]interface{}) (*Permit2CollectPayload, error) {
	auth, ok := data["permit2Authorization"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid permit2Authorization field")
	}
	permitted, ok := auth["permitted"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid permit2Authorization.permitted field")
	}

	payload := &Permit2CollectPayload{}
	payload.Permit2Authorization.From, _ = auth["from"].(string)
	payload.Permit2Authorization.Spender, _ = auth["spender"].(string)
	payload.Permit2Authorization.Nonce, _ = auth["nonce"].(string)
	payload.Permit2Authorization.Deadline, _ = auth["deadline"].(string)
	payload.Permit2Authorization.Permitted.Token, _ = permitted["token"].(string)
	payload.Permit2Authorization.Permitted.Amount, _ = permitted["amount"].(string)

	payload.Signature, _ = data["signature"].(string)
	payload.Salt, _ = data["salt"].(string)
	payload.SaltNonce, _ = data["saltNonce"].(string)
	charge, err := chargeCompletionFromMap(data)
	if err != nil {
		return nil, err
	}
	payload.Charge = charge
	return payload, nil
}

// chargeCompletionFromMap reads the server-added charge fields. The amount, a fee field and
// feeReceiver must be present together or not at all; the authorizer signature is optional
// because a facilitator-delegated authorizer produces it at settle time.
func chargeCompletionFromMap(data map[string]interface{}) (*ChargeCompletion, error) {
	feeBps, hasFeeBps := JSONNumberToUint16(data["feeBps"])
	feeAmount, hasFeeAmount := data["feeAmount"].(string)
	amount, hasAmount := data["amount"].(string)
	feeReceiver, hasFeeReceiver := data["feeReceiver"].(string)
	authorizerSignature, hasAuthorizerSig := data["authorizerSignature"].(string)

	hasFee := hasFeeBps || hasFeeAmount
	if !hasAmount && !hasFee && !hasFeeReceiver && !hasAuthorizerSig {
		return nil, nil
	}
	if !hasAmount || !hasFee || !hasFeeReceiver {
		return nil, fmt.Errorf("charge completion needs amount, a fee field and feeReceiver together")
	}

	charge := &ChargeCompletion{
		Amount:              amount,
		FeeAmount:           feeAmount,
		FeeReceiver:         feeReceiver,
		AuthorizerSignature: authorizerSignature,
	}
	if hasFeeBps {
		charge.FeeBps = &feeBps
	}
	return charge, nil
}

func paymentInfoStructFromMap(v map[string]interface{}) (PaymentInfoStruct, error) {
	info := PaymentInfoStruct{}
	info.Operator, _ = v["operator"].(string)
	info.Payer, _ = v["payer"].(string)
	info.Receiver, _ = v["receiver"].(string)
	info.Token, _ = v["token"].(string)
	info.MaxAmount, _ = v["maxAmount"].(string)
	info.FeeReceiver, _ = v["feeReceiver"].(string)
	info.Salt, _ = v["salt"].(string)

	for key, dst := range map[string]*uint64{
		"preApprovalExpiry":   &info.PreApprovalExpiry,
		"authorizationExpiry": &info.AuthorizationExpiry,
		"refundExpiry":        &info.RefundExpiry,
	} {
		n, ok := JSONNumberToUint64(v[key])
		if !ok {
			return PaymentInfoStruct{}, fmt.Errorf("invalid %s", key)
		}
		*dst = n
	}
	for key, dst := range map[string]*uint16{
		"minFeeBps": &info.MinFeeBps,
		"maxFeeBps": &info.MaxFeeBps,
	} {
		n, ok := JSONNumberToUint16(v[key])
		if !ok {
			return PaymentInfoStruct{}, fmt.Errorf("invalid %s", key)
		}
		*dst = n
	}
	return info, nil
}

// CapturePayloadFromMap parses a wire payload already confirmed by IsCapturePayload.
func CapturePayloadFromMap(data map[string]interface{}) (*CapturePayload, error) {
	infoMap, ok := data["paymentInfo"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid paymentInfo field")
	}
	info, err := paymentInfoStructFromMap(infoMap)
	if err != nil {
		return nil, err
	}

	payload := &CapturePayload{PaymentInfo: info}
	payload.SaltNonce, _ = data["saltNonce"].(string)
	payload.Amount, _ = data["amount"].(string)
	payload.FeeReceiver, _ = data["feeReceiver"].(string)
	payload.FeeAmount, _ = data["feeAmount"].(string)
	payload.ExpectedCapturableAmount, _ = data["expectedCapturableAmount"].(string)
	payload.ExpectedRefundableAmount, _ = data["expectedRefundableAmount"].(string)
	payload.AuthorizerSignature, _ = data["authorizerSignature"].(string)
	payload.VoidAuthorizerSignature, _ = data["voidAuthorizerSignature"].(string)
	payload.VoidRemainder = data["voidRemainder"] == true
	if feeBps, ok := JSONNumberToUint16(data["feeBps"]); ok {
		payload.FeeBps = &feeBps
	}
	return payload, nil
}

// VoidPayloadFromMap parses a wire payload already confirmed by IsVoidPayload.
func VoidPayloadFromMap(data map[string]interface{}) (*VoidPayload, error) {
	infoMap, ok := data["paymentInfo"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid paymentInfo field")
	}
	info, err := paymentInfoStructFromMap(infoMap)
	if err != nil {
		return nil, err
	}

	payload := &VoidPayload{PaymentInfo: info}
	payload.SaltNonce, _ = data["saltNonce"].(string)
	payload.AuthorizerSignature, _ = data["authorizerSignature"].(string)
	payload.VoidAuthorizerSignature, _ = data["voidAuthorizerSignature"].(string)
	return payload, nil
}

// RefundPayloadFromMap parses a wire payload already confirmed by IsRefundPayload.
func RefundPayloadFromMap(data map[string]interface{}) (*RefundPayload, error) {
	infoMap, ok := data["paymentInfo"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("missing or invalid paymentInfo field")
	}
	info, err := paymentInfoStructFromMap(infoMap)
	if err != nil {
		return nil, err
	}

	payload := &RefundPayload{PaymentInfo: info}
	payload.SaltNonce, _ = data["saltNonce"].(string)
	payload.Amount, _ = data["amount"].(string)
	payload.ExpectedCapturableAmount, _ = data["expectedCapturableAmount"].(string)
	payload.ExpectedRefundableAmount, _ = data["expectedRefundableAmount"].(string)
	payload.AuthorizerSignature, _ = data["authorizerSignature"].(string)
	return payload, nil
}
