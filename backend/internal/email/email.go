package email

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

const resendAPI = "https://api.resend.com/emails"

type Sender struct {
	apiKey string
	from   string
}

func NewSender(apiKey, from string) *Sender {
	return &Sender{apiKey: apiKey, from: from}
}

type resendPayload struct {
	From    string   `json:"from"`
	To      []string `json:"to"`
	Subject string   `json:"subject"`
	HTML    string   `json:"html"`
}

// Send delivers an HTML email via the Resend API.
// Falls back to console log if no API key is configured (dev mode).
func (s *Sender) Send(to, subject, htmlBody string) error {
	if s.apiKey == "" {
		fmt.Printf("[EMAIL - no Resend key] To: %s | Subject: %s\n", to, subject)
		printOTPFromBody(htmlBody)
		return nil
	}

	payload := resendPayload{
		From:    s.from,
		To:      []string{to},
		Subject: subject,
		HTML:    htmlBody,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, resendAPI, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+s.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("http do: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("resend error %d: %s", resp.StatusCode, string(respBody))
	}
	return nil
}

// printOTPFromBody extracts and prints the 6-digit OTP code for dev convenience.
func printOTPFromBody(htmlBody string) {
	for i := 0; i < len(htmlBody)-5; i++ {
		if htmlBody[i] >= '0' && htmlBody[i] <= '9' {
			end := i
			for end < len(htmlBody) && htmlBody[end] >= '0' && htmlBody[end] <= '9' {
				end++
			}
			if end-i == 6 {
				fmt.Printf("[EMAIL] OTP CODE: %s\n", htmlBody[i:end])
				return
			}
		}
	}
}

func OTPEmailBody(code, appName string) string {
	return fmt.Sprintf(`<!DOCTYPE html>
<html><body style="font-family:sans-serif;background:#161823;color:#fff;padding:40px;">
<div style="max-width:400px;margin:auto;background:#1F2030;border-radius:16px;padding:32px;border:1px solid #2D2F3E;">
  <h1 style="color:#FE2C55;font-size:28px;margin:0 0 8px;">%s</h1>
  <p style="color:#aaa;margin:0 0 24px;">Email Verification</p>
  <p style="color:#ccc;margin:0 0 16px;">Your verification code is:</p>
  <div style="background:#161823;border-radius:12px;padding:20px;text-align:center;letter-spacing:12px;font-size:36px;font-weight:bold;color:#FE2C55;border:1px solid #2D2F3E;">%s</div>
  <p style="color:#888;font-size:12px;margin-top:20px;">This code expires in 10 minutes. Do not share it with anyone.</p>
</div>
</body></html>`, appName, code)
}
